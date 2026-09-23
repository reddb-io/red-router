import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getApiKeyPolicy: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getApiKeyPolicy: mocks.getApiKeyPolicy,
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");

const conn = (id, provider) => ({
  id,
  provider,
  authType: "oauth",
  isActive: true,
  priority: 1,
  providerSpecificData: { enabledModels: [`${provider}-model-1`] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getApiKeyPolicy.mockResolvedValue({ id: null, modelAccess: null, limits: null });
  mocks.getProviderConnections.mockResolvedValue([conn("a", "claude"), conn("b", "openai")]);
});

afterEach(() => vi.unstubAllGlobals());

const providersOf = (models) => [...new Set(models.map((m) => m.owned_by))].sort();

describe("/v1/models — account binding", () => {
  it("lists only the providers of the key's accounts", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["b"]);

    const models = await buildModelsList(["llm"], { apiKey: "sk-bound", skipDynamicFetch: true });

    expect(providersOf(models)).toEqual(["openai"]);
  });

  it("lists every provider for an unbound key", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);

    const models = await buildModelsList(["llm"], { apiKey: "sk-free", skipDynamicFetch: true });

    expect(providersOf(models)).toEqual(["claude-code", "openai"]);
  });

  // The static-catalog fallback exists for an unreachable DB. A key whose
  // accounts all vanished must get an empty list, never the full catalog.
  it("returns nothing when the key's accounts no longer exist", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["gone"]);

    const models = await buildModelsList(["llm"], { apiKey: "sk-orphan", skipDynamicFetch: true });

    expect(models).toEqual([]);
  });

  it("still falls back to the static catalog when the DB is unreachable", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);

    const models = await buildModelsList(["llm"], { apiKey: null, skipDynamicFetch: true });

    expect(models.length).toBeGreaterThan(0);
  });
});


describe("remote RedRouter catalog exposure", () => {
  it("publishes saved remote models with intact upstream IDs and capabilities", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
    mocks.getProviderConnections.mockResolvedValue([{
      id: "remote", provider: "red-router", isActive: true,
      providerSpecificData: {
        modelsSyncedAt: new Date().toISOString(),
        discoveredModels: [
          { id: "cc/claude-fable-5.1", capabilities: { tools: true, contextWindow: 200000 } },
          { id: "openai/gpt-example" }, { id: "remote-combo" },
        ],
      },
    }]);
    const result = await buildModelsList(["llm"]);
    expect(result.map((m) => m.id)).toEqual([
      "red-router/cc/claude-fable-5.1", "red-router/openai/gpt-example", "red-router/remote-combo",
    ]);
    expect(result[0]).toMatchObject({ capabilities: { tools: true }, context_length: 200000 });
  });

  it("does not query or expose remote accounts excluded by the local client key", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["local"]);
    mocks.getProviderConnections.mockResolvedValue([conn("local", "claude"), { id: "remote", provider: "red-router", isActive: true }]);
    vi.stubGlobal("fetch", vi.fn());
    expect(providersOf(await buildModelsList(["llm"], { apiKey: "bound" }))).toEqual(["claude-code"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("breaks reciprocal catalog discovery without recursively advertising saved remote catalogs", async () => {
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
    mocks.getProviderConnections.mockResolvedValue([{
      id: "remote", provider: "red-router", isActive: true,
      providerSpecificData: { discoveredModels: [{ id: "red-router/cc/claude-fable-5.1" }] },
    }]);
    vi.stubGlobal("fetch", vi.fn());
    expect(await buildModelsList(["llm"], { skipDynamicFetch: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("/v1/models — key model rules", () => {
  beforeEach(() => mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null));

  it("lists only what an allow-list key may call, matched by any prefix spelling", async () => {
    mocks.getApiKeyPolicy.mockResolvedValue({ modelAccess: { mode: "allow", patterns: ["cc/*"] } });

    const models = await buildModelsList(["llm"], { apiKey: "sk-allow", skipDynamicFetch: true });

    expect(providersOf(models)).toEqual(["claude-code"]);
  });

  it("hides denied models and keeps combos a key may call", async () => {
    mocks.getCombos.mockResolvedValue([{ name: "team-fast", models: ["openai/openai-model-1"] }, { name: "blocked", models: [] }]);
    mocks.getApiKeyPolicy.mockResolvedValue({ modelAccess: { mode: "deny", patterns: ["openai/*", "blocked"] } });

    const models = await buildModelsList(["llm"], { apiKey: "sk-deny", skipDynamicFetch: true });

    expect(models.map((m) => m.id)).toContain("team-fast");
    expect(models.map((m) => m.id)).not.toContain("blocked");
    expect(models.some((m) => m.owned_by === "openai")).toBe(false);
  });
});
