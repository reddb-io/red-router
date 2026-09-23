// /v1/models lists one entry per base model: level and mode variant ids fold into the
// base entry's thinking_levels, parameters.modes and `variants`. Variant ids keep
// routing, and a base id with a level routes to the variant that serves it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVariantRequest, groupModelVariants, mergeVariantLevels } from "../../open-sse/providers/modelVariants.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: vi.fn(async () => null),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getSettings: mocks.getSettings,
  getApiKeyOwner: vi.fn(async () => null),
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildModelsList, GET: listModels } = await import("@/app/api/v1/models/route.js");
const { GET: getModel } = await import("@/app/api/v1/models/[...model]/route.js");

const conn = (id, provider, enabledModels) => ({ id, provider, isActive: true, priority: 1, providerSpecificData: { enabledModels } });
const byId = (list, id) => list.find((m) => m.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({});
  mocks.getProviderConnections.mockResolvedValue([
    conn("cx", "codex", ["gpt-5.5", "gpt-5.5-review", "codex-auto-review"]),
    conn("ag", "antigravity", ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"]),
    conn("gcli", "grok-cli", ["grok-4.5", "grok-4.5-high", "grok-4.5-low"]),
    conn("kr", "kiro", ["claude-sonnet-4.5", "claude-sonnet-4.5-thinking", "claude-sonnet-4.5-agentic", "claude-sonnet-4.5-thinking-agentic"]),
  ]);
});

describe("/v1/models collapsed variants", () => {
  it("folds Codex -review into the base entry as a review mode", async () => {
    const list = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(byId(list, "codex/gpt-5.5-review")).toBeUndefined();
    const base = byId(list, "codex/gpt-5.5");
    expect(base.parameters.modes).toEqual(["review"]);
    expect(base.variants).toEqual([
      { id: "codex/gpt-5.5-review", name: "GPT 5.5 Review", mode: "review", aliases: ["cx/gpt-5.5-review"] },
    ]);
    // Not derived from a base model: stays its own entry.
    expect(byId(list, "codex/codex-auto-review")).toBeDefined();
  });

  it("folds Antigravity level ids into thinking_levels, listing a table base in place of its variants", async () => {
    const list = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const flash37 = byId(list, "antigravity/gemini-3.7-flash");
    expect(flash37).toMatchObject({ name: "Gemini 3.7 Flash", owned_by: "antigravity" });
    expect(flash37.thinking_levels).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    expect(flash37.parameters.thinking_levels).toEqual(flash37.thinking_levels);
    expect(flash37.variants.map((v) => [v.id, v.level])).toEqual([
      ["antigravity/gemini-3.7-flash-low", "low"],
      ["antigravity/gemini-3.7-flash-medium", "medium"],
      ["antigravity/gemini-3.7-flash-high", "high"],
    ]);
    expect(flash37.variants[0].aliases).toEqual(["ag/gemini-3.7-flash-low"]);
    expect(byId(list, "antigravity/gemini-3.7-flash-high")).toBeUndefined();
    expect(byId(list, "antigravity/gemini-3.8-flash").variants).toEqual([
      expect.objectContaining({ id: "antigravity/gemini-3.8-flash-high", level: "high" }),
    ]);
  });

  it("folds Grok CLI and Kiro variants", async () => {
    const list = await buildModelsList(["llm"], { skipDynamicFetch: true });
    const grok = byId(list, "grok-cli/grok-4.5");
    expect(grok.variants.map((v) => v.level)).toEqual(["low", "high"]);
    expect(byId(list, "grok-cli/grok-4.5-high")).toBeUndefined();

    const sonnet = byId(list, "kiro/claude-sonnet-4.5");
    expect(sonnet.thinking_levels).toEqual(["thinking"]);
    expect(sonnet.parameters).toMatchObject({ reasoning: true, thinking_levels: ["thinking"], modes: ["agentic"] });
    expect(sonnet.variants.map((v) => [v.id, v.level ?? null, v.mode ?? null])).toEqual([
      ["kiro/claude-sonnet-4.5-thinking", "thinking", null],
      ["kiro/claude-sonnet-4.5-agentic", null, "agentic"],
      ["kiro/claude-sonnet-4.5-thinking-agentic", "thinking", "agentic"],
    ]);
  });

  it("lists every variant id as its own entry with ?variants=expand or catalog.variants", async () => {
    const response = await listModels(new Request("https://router.test/v1/models?variants=expand"));
    const expanded = (await response.json()).data;
    expect(byId(expanded, "codex/gpt-5.5-review")).toBeDefined();
    expect(byId(expanded, "antigravity/gemini-3.7-flash-high")).toBeDefined();
    expect(byId(expanded, "antigravity/gemini-3.7-flash")).toBeUndefined();
    expect(byId(expanded, "codex/gpt-5.5").variants).toBeUndefined();

    mocks.getSettings.mockResolvedValue({ catalog: { variants: "expand" } });
    expect(byId(await buildModelsList(["llm"], { skipDynamicFetch: true }), "kiro/claude-sonnet-4.5-thinking")).toBeDefined();
  });

  it("finds the base entry by a variant id on /v1/models/{id}", async () => {
    for (const path of [["codex", "gpt-5.5-review"], ["cx", "gpt-5.5-review"]]) {
      const response = await getModel(new Request(`https://router.test/v1/models/${path.join("/")}`), { params: Promise.resolve({ model: path }) });
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe("codex/gpt-5.5");
    }
  });
});

describe("variant routing", () => {
  it.each([
    ["antigravity", "gemini-3.8-flash(high)", "gemini-3.8-flash-high"],
    ["antigravity", "gemini-3.8-flash", "gemini-3.8-flash"],
    ["antigravity", "gemini-3.7-flash", "gemini-3.7-flash-medium"],
    ["antigravity", "gemini-3.7-flash(low)", "gemini-3.7-flash-low"],
    ["antigravity", "gemini-3.8-flash(minimal)", "gemini-3.8-flash(minimal)"],
    ["antigravity", "gemini-3.8-flash-high", "gemini-3.8-flash-high"],
    ["grok-cli", "grok-4.5(high)", "grok-4.5-high"],
    ["kiro", "claude-sonnet-4.5(thinking)", "claude-sonnet-4.5-thinking"],
    ["kiro", "claude-sonnet-4.5-agentic(thinking)", "claude-sonnet-4.5-thinking-agentic"],
    ["kiro", "claude-opus-5(high)", "claude-opus-5(high)"],
    ["kiro", "claude-sonnet-4.5-thinking(thinking)", "claude-sonnet-4.5-thinking(thinking)"],
    ["cursor", "claude-4.5-sonnet(thinking)", "claude-4.5-sonnet-thinking"],
    ["codex", "gpt-5.5-review", "gpt-5.5-review"],
    ["codex", "gpt-5.5(high)", "gpt-5.5(high)"],
    ["openai", "gpt-4o(high)", "gpt-4o(high)"],
  ])("%s %s calls %s", (provider, requested, called) => {
    expect(resolveVariantRequest(provider, requested)).toBe(called);
  });

  it("reaches the variant's own upstream id", () => {
    expect(getModelUpstreamId("ag", resolveVariantRequest("antigravity", "gemini-3.8-flash(high)"))).toBe("gemini-3.8-flash-high(high)");
    expect(getModelUpstreamId("cx", "gpt-5.5-review")).toBe("gpt-5.5");
  });

  it("only folds a suffix variant whose base is listed", () => {
    expect(groupModelVariants("codex", ["codex-auto-review", "gpt-5.5-review"]).size).toBe(0);
  });

  it("orders merged levels canonically", () => {
    expect(mergeVariantLevels(["high", "low"], [{ level: "medium" }, { level: "thinking" }])).toEqual(["low", "medium", "high", "thinking"]);
    expect(mergeVariantLevels(null, [{ mode: "review" }])).toBeNull();
  });
});
