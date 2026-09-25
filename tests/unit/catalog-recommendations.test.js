// GET /v1/catalog groups the /v1/models entries by provider and recommends models
// for the connected accounts from documented ranking tables.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRecommendations, planRecommendedCombos, parseVersion } from "../../src/lib/modelRecommendations.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: vi.fn(async () => null),
  getCombos: mocks.getCombos,
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getSettings: mocks.getSettings,
  getApiKeyOwner: vi.fn(async () => null),
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildCatalog } = await import("@/lib/catalog.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { GET: getCatalog } = await import("@/app/api/v1/catalog/route.js");
const { resetCatalogVersions } = await import("@/lib/catalogVersion");

const conn = (id, provider, enabledModels) => ({ id, provider, isActive: true, priority: 1, providerSpecificData: { enabledModels } });

// A /v1/models entry as buildModelsList emits it, reduced to what recommendations read.
const SUB = { subscription: true };
const PAID = { subscription: false };
const entry = (id, name, provider, extra = {}) => ({
  id: `${provider.slug}/${id}`,
  object: "model",
  owned_by: provider.slug,
  name,
  provider: { id: provider.id || provider.slug, slug: provider.slug, name: provider.name, ...provider.plan },
  ...extra,
});
const CLAUDE_CODE = { id: "claude", slug: "claude-code", name: "Claude Code", plan: SUB };
const ANTHROPIC = { id: "anthropic", slug: "anthropic", name: "Anthropic", plan: PAID };
const CODEX = { id: "codex", slug: "codex", name: "OpenAI Codex", plan: SUB };
const OPENAI = { id: "openai", slug: "openai", name: "OpenAI", plan: PAID };
const GEMINI = { id: "gemini", slug: "gemini", name: "Gemini", plan: PAID };
const KIRO = { id: "kiro", slug: "kiro", name: "Kiro AI", plan: SUB };

describe("recommendation ranking tables", () => {
  it("parses the family version, ignoring dates", () => {
    expect(parseVersion("claude-opus-5-5")).toEqual([5, 5]);
    expect(parseVersion("gpt-5.6-sol")).toEqual([5, 6]);
    expect(parseVersion("claude-opus-4-20250514")).toEqual([4, 0]);
    expect(parseVersion("claude-haiku-4-5-20251001")).toEqual([4, 5]);
    expect(parseVersion("kimi-for-coding")).toEqual([0, 0]);
  });

  it("default: claude opus beats gpt-6 sol beats gemini pro, newest version first", () => {
    const models = [
      entry("gemini-3.1-pro", "Gemini 3.1 Pro", GEMINI),
      entry("gpt-6-sol", "GPT 6.0 Sol", CODEX),
      entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
      entry("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_CODE),
    ];
    const { recommended } = buildRecommendations(models);
    expect(recommended.default).toEqual({
      id: "claude-code/claude-opus-5-5",
      name: "Claude Opus 5.5",
      provider: { slug: "claude-code", name: "Claude Code" },
      reason: "Strongest connected coding model (claude-opus family, newest version).",
    });
    expect(buildRecommendations(models.slice(0, 2)).recommended.default.id).toBe("codex/gpt-6-sol");
    expect(buildRecommendations(models.slice(0, 1)).recommended.default.id).toBe("gemini/gemini-3.1-pro");
  });

  it("prefers a subscription account over a metered key serving the same model", () => {
    const models = [
      entry("claude-opus-5", "Claude Opus 5", ANTHROPIC),
      entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
    ];
    const { recommended, combos } = buildRecommendations(models);
    expect(recommended.default.id).toBe("claude-code/claude-opus-5");
    expect(recommended.default.reason).toContain("subscription account is preferred over a metered API key");
    // The metered account stays as the fallback.
    expect(combos.find((c) => c.name === "default").models).toEqual(["claude-code/claude-opus-5", "anthropic/claude-opus-5"]);
  });

  it("does not trade capability for a subscription", () => {
    const models = [
      entry("claude-opus-5", "Claude Opus 5", ANTHROPIC),
      entry("claude-sonnet-5", "Claude Sonnet 5", CLAUDE_CODE),
    ];
    expect(buildRecommendations(models).recommended.default.id).toBe("anthropic/claude-opus-5");
  });

  it("fast: cheapest capable fast model (gpt-6 luna, then gemini flash, then haiku)", () => {
    const models = [
      entry("claude-haiku-4.5", "Claude Haiku 4.5", KIRO),
      entry("gemini-3.8-flash", "Gemini 3.8 Flash", GEMINI),
      entry("gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite", GEMINI),
      entry("gpt-6-luna", "GPT 6.0 Luna", CODEX),
    ];
    const { recommended, combos } = buildRecommendations(models);
    expect(recommended.fast).toMatchObject({ id: "codex/gpt-6-luna", reason: "Cheapest capable fast model (gpt-6-luna family)." });
    expect(combos.find((c) => c.name === "fast").models).toEqual(["codex/gpt-6-luna", "gemini/gemini-3.8-flash", "kiro/claude-haiku-4.5"]);
    expect(buildRecommendations(models.slice(0, 1)).recommended.fast.id).toBe("kiro/claude-haiku-4.5");
  });

  it("review: the review variant of a model with modes: ['review'], else the default", () => {
    const models = [
      entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
      entry("gpt-5.5", "GPT 5.5", CODEX, {
        parameters: { modes: ["review"] },
        variants: [{ id: "codex/gpt-5.5-review", name: "GPT 5.5 Review", mode: "review" }],
      }),
    ];
    const { recommended } = buildRecommendations(models);
    expect(recommended.review).toMatchObject({ id: "codex/gpt-5.5-review", name: "GPT 5.5 Review", provider: { slug: "codex" } });

    const withoutReview = buildRecommendations(models.slice(0, 1)).recommended;
    expect(withoutReview.review).toMatchObject({
      id: "claude-code/claude-opus-5",
      reason: "No connected model has a review mode; using the default model.",
    });
  });

  it("systemone: the first JEV model; vision only when a model reads images", () => {
    const jev = [
      { id: "jev/other", name: "Other", provider: { slug: "jev", name: "TypeSafe AI (JEV)" } },
      { id: "jev/jev-latest", name: "JEV Latest", provider: { slug: "jev", name: "TypeSafe AI (JEV)" } },
    ];
    const models = [entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE)];
    const noVision = buildRecommendations(models, jev).recommended;
    expect(noVision.systemone).toMatchObject({ id: "jev/jev-latest", provider: { slug: "jev", name: "TypeSafe AI (JEV)" } });
    expect(noVision).not.toHaveProperty("vision");

    const vision = buildRecommendations([...models, entry("gpt-6-luna", "GPT 6.0 Luna", CODEX, { capabilities: { vision: true } })]).recommended;
    expect(vision.vision.id).toBe("codex/gpt-6-luna");
    expect(vision.systemone).toBeNull();
  });

  it("falls back to the first catalog model when no family is ranked, and ignores combos", () => {
    const custom = { id: "openai-compatible-x", slug: "local", name: "Local", plan: PAID };
    const models = [
      { id: "default", object: "model", owned_by: "combo", name: "default", provider: { id: "combo", name: "Combo" } },
      entry("llama-4", "Llama 4", custom),
    ];
    const { recommended, combos } = buildRecommendations(models);
    expect(recommended.default.id).toBe("local/llama-4");
    expect(recommended.fast.id).toBe("local/llama-4");
    expect(combos.map((c) => [c.name, c.models])).toEqual([
      ["default", ["local/llama-4"]],
      ["fast", ["local/llama-4"]],
      ["review", ["local/llama-4"]],
    ]);
    expect(buildRecommendations([]).recommended).toEqual({ default: null, fast: null, review: null, systemone: null });
    expect(buildRecommendations([]).combos).toEqual([]);
  });

  it("builds combo members across providers first, capped at three", () => {
    const models = [
      entry("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_CODE),
      entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
      entry("claude-opus-5", "Claude Opus 5", KIRO),
      entry("gpt-6-sol", "GPT 6.0 Sol", CODEX),
      entry("gpt-6-sol", "GPT 6.0 Sol", OPENAI),
    ];
    const combo = buildRecommendations(models).combos.find((c) => c.name === "default");
    expect(combo.models).toEqual(["claude-code/claude-opus-5-5", "kiro/claude-opus-5", "codex/gpt-6-sol"]);
  });
});

describe("planRecommendedCombos", () => {
  const specs = [
    { name: "default", role: "default", models: ["claude-code/claude-opus-5"], reason: "r" },
    { name: "fast", role: "fast", models: ["codex/gpt-6-luna"], reason: "r" },
    { name: "review", role: "review", models: ["codex/gpt-5.5-review"], reason: "r" },
  ];

  it("creates missing combos, updates changed ones and leaves matching ones alone", () => {
    const existing = [
      { id: "c1", name: "default", models: ["claude-code/claude-opus-5"], owner: null },
      { id: "c2", name: "fast", models: ["cc/claude-haiku-4.5"], owner: null },
    ];
    const plan = planRecommendedCombos(specs, existing);
    expect(plan.map((item) => [item.name, item.action, item.comboId])).toEqual([
      ["default", "unchanged", "c1"],
      ["fast", "update", "c2"],
      ["review", "create", undefined],
    ]);
    expect(plan[1].current).toEqual(["cc/claude-haiku-4.5"]);
  });

  it("never edits a shared combo for a scoped user", () => {
    const existing = [{ id: "s1", name: "fast", models: ["x/y"], owner: null }];
    expect(planRecommendedCombos(specs, existing, { owner: "ana@example.com" })[1]).toMatchObject({ action: "blocked", comboId: "s1" });
    expect(planRecommendedCombos(specs, [...existing, { id: "o1", name: "fast", models: ["x/y"], owner: "ana@example.com" }], { owner: "ana@example.com" })[1])
      .toMatchObject({ action: "update", comboId: "o1" });
  });
});

describe("GET /v1/catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCatalogVersions();
    mocks.getSettings.mockResolvedValue({});
    mocks.getCombos.mockResolvedValue([{ id: "k1", name: "coding", models: ["claude-code/claude-opus-5"] }]);
    mocks.getProviderConnections.mockResolvedValue([
      conn("cc1", "claude", ["claude-opus-5", "claude-haiku-4-5"]),
      conn("cc2", "claude", ["claude-opus-5"]),
      conn("cx", "codex", ["gpt-6-sol", "gpt-6-luna", "gpt-5.5", "gpt-5.5-review"]),
      conn("an", "anthropic", ["claude-opus-5"]),
    ]);
  });

  it("groups the /v1/models entries by provider with connection counts", async () => {
    const catalog = await buildCatalog({});
    const list = await buildModelsList(["llm"], {});
    expect(catalog.groups.map((g) => [g.provider.slug, g.provider.connections, g.models.map((m) => m.id)])).toEqual([
      ["claude-code", 2, ["claude-code/claude-opus-5", "claude-code/claude-haiku-4-5"]],
      ["codex", 1, ["codex/gpt-6-sol", "codex/gpt-6-luna", "codex/gpt-5.5"]],
      ["anthropic", 1, ["anthropic/claude-opus-5"]],
    ]);
    expect(catalog.groups[0].provider).toEqual({
      id: "claude",
      slug: "claude-code",
      prefix: "cc",
      name: "Claude Code",
      category: "oauth",
      subscription: true,
      connections: 2,
    });
    // Same entries as /v1/models.
    expect(catalog.groups[1].models[2]).toEqual(list.find((m) => m.id === "codex/gpt-5.5"));
    expect(catalog.combos.map((c) => c.id)).toEqual(["coding"]);
  });

  it("recommends from the connected providers", async () => {
    const { recommended } = await buildCatalog({});
    expect(recommended.default).toMatchObject({ id: "claude-code/claude-opus-5", provider: { slug: "claude-code", name: "Claude Code" } });
    expect(recommended.fast.id).toBe("codex/gpt-6-luna");
    expect(recommended.review.id).toBe("codex/gpt-5.5-review");
    expect(recommended.systemone).toBeNull();
  });

  it("recommends nothing when no account is connected", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const catalog = await buildCatalog({});
    expect(catalog.recommended).toEqual({ default: null, fast: null, review: null, systemone: null });
  });

  it("serves the document with the catalog version header", async () => {
    const response = await getCatalog(new Request("http://localhost/v1/catalog?for=redcode"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    expect(response.headers.get("X-RedRouter-Catalog-Version")).toBe(body.version);
    expect(Object.keys(body)).toEqual(["version", "groups", "combos", "aliases", "recommended", "id_format"]);
    // Grouped by provider, the catalog always uses prefixed ids.
    expect(body.id_format).toBe("prefixed");
  });
});
