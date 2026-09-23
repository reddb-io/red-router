// /v1/models lists readable "<slug>/<model>" ids. Every provider token — slug, id,
// alias, aliases[], uiAlias — keeps routing, so ids clients saved under the legacy
// short codes ("cc/<model>") resolve forever and the catalog tells clients about them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { parseModel as parseModelCore } from "../../open-sse/services/model.js";
import { providerIdentity } from "../../open-sse/providers/identity.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getSettings: vi.fn(),
  getComboByName: vi.fn(),
  getProviderNodes: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getSettings: mocks.getSettings,
  getApiKeyOwner: vi.fn(async () => null),
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { GET: getModel } = await import("@/app/api/v1/models/[...model]/route.js");
const { parseModel: parseModelApp, getModelInfo } = await import("@/sse/services/model.js");

const conn = (id, provider, enabledModels, extra = {}) => ({
  id,
  provider,
  isActive: true,
  priority: 1,
  providerSpecificData: { enabledModels, ...extra },
});

const claudeModel = PROVIDER_MODELS.cc[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.getProviderConnections.mockResolvedValue([conn("a", "claude", [claudeModel.id])]);
});

afterEach(() => vi.unstubAllGlobals());

describe("registry slugs", () => {
  it("gives every provider a unique kebab-case slug", () => {
    const slugs = REGISTRY.map((entry) => entry.slug);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // Also guards `tr`: TokenRouter owns it while Trae (whose alias it also is) stays disabled.
  it("never lets two providers claim the same token", () => {
    const owners = new Map();
    for (const entry of REGISTRY) {
      const tokens = new Set([entry.id, entry.slug, entry.alias, entry.uiAlias, ...(entry.aliases || [])].filter(Boolean));
      for (const token of tokens) owners.set(token, [...(owners.get(token) || []), entry.id]);
    }
    const shared = [...owners].filter(([, ids]) => ids.length > 1);
    expect(shared).toEqual([]);
  });

  it("uses the readable names chosen for subscription providers", () => {
    const slugOf = (id) => REGISTRY.find((entry) => entry.id === id)?.slug;
    expect(slugOf("claude")).toBe("claude-code");
    expect(slugOf("github")).toBe("copilot");
    expect(slugOf("kilocode")).toBe("kilo-code");
    expect(slugOf("typesafe-ai")).toBe("jev");
    expect(slugOf("codex")).toBe("codex");
    expect(slugOf("perplexity-agent")).toBe("perplexity-agent");
  });
});

describe("provider resolution", () => {
  const TABLE = [
    ["claude-code/claude-opus-5", "claude"],
    ["cc/claude-opus-5", "claude"],
    ["claude/claude-opus-5", "claude"],
    ["copilot/gpt-4o", "github"],
    ["gh/gpt-4o", "github"],
    ["codex/gpt-5.5", "codex"],
    ["cx/gpt-5.5", "codex"],
    ["kilo-code/some-model", "kilocode"],
    ["kc/some-model", "kilocode"],
    ["jev/jev-latest", "typesafe-ai"],
    // uiAlias-only tokens used to fall through to the OpenAI executor
    ["pa/sonar-pro", "perplexity-agent"],
    ["voyage/voyage-3", "voyage-ai"],
    // `mmf` was shadowed by a hidden duplicate provider of the same id
    ["mmf/mimo-auto", "mimo-free"],
    ["tr/some-model", "tokenrouter"],
  ];

  it.each(TABLE)("core parseModel resolves %s to %s", (model, provider) => {
    expect(parseModelCore(model).provider).toBe(provider);
  });

  it.each(TABLE)("app parseModel resolves %s to %s", (model, provider) => {
    expect(parseModelApp(model).provider).toBe(provider);
  });

  it("routes pa/ to the Perplexity Agent transport, not the OpenAI fallback", async () => {
    const info = await getModelInfo("pa/sonar-pro");
    expect(info).toEqual({ provider: "perplexity-agent", model: "sonar-pro" });
    expect(getExecutor(info.provider).config).toBe(PROVIDERS["perplexity-agent"]);
    expect(getExecutor(info.provider).config.baseUrl).toContain("api.perplexity.ai");
  });

  it("routes voyage/ to Voyage AI embeddings", async () => {
    const info = await getModelInfo("voyage/voyage-3");
    expect(info).toEqual({ provider: "voyage-ai", model: "voyage-3" });
    expect(PROVIDER_MEDIA["voyage-ai"].embeddingConfig.baseUrl).toContain("voyageai.com");
  });

  it("does not let a custom node prefix shadow a built-in slug", async () => {
    mocks.getProviderNodes.mockResolvedValue([{ id: "openai-compatible-x", prefix: "claude-code" }]);
    expect(await getModelInfo("claude-code/claude-opus-5")).toEqual({ provider: "claude", model: "claude-opus-5" });
  });
});

describe("/v1/models entries", () => {
  it("lists readable ids with name, provider identity and the legacy id as an alias", async () => {
    const [entry] = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(entry).toMatchObject({
      id: `claude-code/${claudeModel.id}`,
      object: "model",
      owned_by: "claude-code",
      name: claudeModel.name,
      provider: {
        id: "claude",
        slug: "claude-code",
        prefix: "cc",
        name: "Claude Code",
        category: "oauth",
        subscription: true,
      },
      aliases: [`cc/${claudeModel.id}`],
    });
    expect(entry.context_length).toBeGreaterThan(0);
  });

  it("marks metered API-key providers as not subscriptions and omits aliases when the slug is the only prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("b", "openai", ["gpt-4o"])]);
    const [entry] = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(entry).toMatchObject({ id: "openai/gpt-4o", owned_by: "openai", provider: { id: "openai", subscription: false } });
    expect(entry.aliases).toBeUndefined();
  });

  it("keeps the legacy short codes when catalog.prefixStyle is short", async () => {
    mocks.getSettings.mockResolvedValue({ catalog: { prefixStyle: "short" } });
    const [entry] = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(entry).toMatchObject({
      id: `cc/${claudeModel.id}`,
      owned_by: "cc",
      aliases: [`claude-code/${claudeModel.id}`],
      provider: { slug: "claude-code", prefix: "cc" },
    });
  });

  it("keeps a custom node's own prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn("n", "openai-compatible-abc", ["m1"], { prefix: "mine", nodeName: "My Node" }),
    ]);
    const [entry] = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(entry).toMatchObject({
      id: "mine/m1",
      owned_by: "mine",
      name: "m1",
      provider: { id: "openai-compatible-abc", slug: "mine", prefix: "mine", name: "My Node", category: "custom", subscription: false },
    });
    expect(entry.aliases).toBeUndefined();
  });

  it("names combos and gives them the combo provider", async () => {
    mocks.getCombos.mockResolvedValue([{ name: "mix", models: [`cc/${claudeModel.id}`] }]);
    const list = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(list.find((m) => m.id === "mix")).toMatchObject({
      owned_by: "combo",
      name: "mix",
      provider: { id: "combo", name: "Combo" },
      members: [`cc/${claudeModel.id}`],
    });
  });

  it("passes a remote RedRouter's name and provider through and marks the hop", async () => {
    const remoteProvider = { id: "claude", slug: "claude-code", prefix: "cc", name: "Claude Code", category: "oauth", subscription: true };
    mocks.getProviderConnections.mockResolvedValue([{
      id: "remote", provider: "red-router", isActive: true,
      providerSpecificData: {
        modelsSyncedAt: new Date().toISOString(),
        discoveredModels: [
          { id: "claude-code/claude-opus-5", name: "Claude Opus 5", provider: remoteProvider, aliases: ["cc/claude-opus-5"] },
          { id: "old-remote/model" },
        ],
      },
    }]);
    const [modern, legacy] = await buildModelsList(["llm"]);
    expect(modern).toMatchObject({
      id: "red-router/claude-code/claude-opus-5",
      owned_by: "red-router",
      name: "Claude Opus 5",
      provider: remoteProvider,
      aliases: ["red-router/cc/claude-opus-5"],
      via: "red-router",
    });
    expect(legacy).toMatchObject({ id: "red-router/old-remote/model", name: "old-remote/model", provider: { id: "red-router" }, via: "red-router" });
  });

  it("finds an entry by its legacy id on /v1/models/{id}", async () => {
    const response = await getModel(
      new Request(`https://router.test/v1/models/cc/${claudeModel.id}`),
      { params: Promise.resolve({ model: ["cc", claudeModel.id] }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(`claude-code/${claudeModel.id}`);
  });

  it("exposes the provider block from the registry", () => {
    expect(providerIdentity("perplexity-agent")).toEqual({
      id: "perplexity-agent",
      slug: "perplexity-agent",
      prefix: "pa",
      name: "Perplexity Agent",
      category: "apikey",
      subscription: false,
    });
    expect(providerIdentity("nope")).toBeNull();
  });
});
