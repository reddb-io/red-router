import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), getApiKeyAllowedConnectionIds: vi.fn(), getCombos: vi.fn(),
  getCustomModels: vi.fn(), getModelAliases: vi.fn(), getDisabledModels: vi.fn(), getApiKeyPolicy: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ ...mocks }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { resolveFlatModel, resetFlatModelCache } = await import("@/sse/services/flatResolve.js");

const conn = (id, provider, models) => ({ id, provider, authType: "apikey", isActive: true, priority: 1, providerSpecificData: { enabledModels: models } });

beforeEach(() => {
  vi.clearAllMocks();
  resetFlatModelCache();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getApiKeyPolicy.mockResolvedValue({ id: null, modelAccess: null, limits: null });
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getProviderConnections.mockResolvedValue([
    conn("a", "openrouter", ["anthropic/claude-sonnet-4.5"]),
    conn("b", "anthropic", ["claude-sonnet-4-5"]),
  ]);
});

describe("/v1/models with flat ids", () => {
  it("keeps the prefixed catalog unchanged by default", async () => {
    const ids = (await buildModelsList(["llm"], { skipDynamicFetch: true })).map((m) => m.id).sort();
    expect(ids).toEqual(["anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-sonnet-4.5"]);
  });

  it("lists one entry per model, shaped as an implicit fallback combo over its offers", async () => {
    const list = await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat" });
    expect(list.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    const [claude] = list;
    expect(claude).toMatchObject({
      owned_by: "combo", flat: true, strategy: "fallback", canonical: "anthropic/claude-sonnet-4-5",
      // Same price: the vendor's own offer leads the reseller's.
      members: ["anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-sonnet-4.5"],
      parameters_basis: "lead",
    });
    expect(claude.member_parameters.map((m) => m.id)).toEqual(claude.members);
    expect(claude.offers[1]).toMatchObject({
      id: "openrouter/anthropic/claude-sonnet-4.5",
      pin_id: "openrouter/anthropic/claude-sonnet-4.5",
      provider: { id: "openrouter" },
      via: [],
      available: true,
      free: false,
    });
    // The vendor's offer id is the flat id itself: it pins through an alias, or not at all.
    expect(claude.offers[0].id).toBe("anthropic/claude-sonnet-4-5");
    expect(claude.offers[0].pin_id).not.toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("requests with flat ids", () => {
  it("resolves a flat id to its offers in policy order", async () => {
    // A name that is only a flat id resolves for any key.
    mocks.getProviderConnections.mockResolvedValue([conn("a", "openrouter", ["anthropic/claude-sonnet-4.5"])]);
    const resolved = await resolveFlatModel("anthropic/claude-sonnet-4-5(high)", { apiKey: null });
    expect(resolved).toEqual({
      models: ["openrouter/anthropic/claude-sonnet-4.5(high)"],
      comboName: "anthropic/claude-sonnet-4-5",
      suffix: "(high)",
      flat: true,
    });
  });

  it("leaves an id that is also an offer to that offer for a prefixed key", async () => {
    expect(await resolveFlatModel("anthropic/claude-sonnet-4-5", { apiKey: null })).toBeNull();
    expect(await resolveFlatModel("openrouter/anthropic/claude-sonnet-4.5", { apiKey: null })).toBeNull();
    expect(await resolveFlatModel("nobody/made-this-up", { apiKey: null })).toBeNull();
  });
});
