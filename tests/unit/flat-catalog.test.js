import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), getApiKeyAllowedConnectionIds: vi.fn(), getCombos: vi.fn(),
  getCustomModels: vi.fn(), getModelAliases: vi.fn(), getDisabledModels: vi.fn(), getApiKeyPolicy: vi.fn(),
  getSettings: vi.fn(), updateSettings: vi.fn(),
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
  mocks.getSettings.mockResolvedValue({});
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

describe("an admin's offer order (Models page)", () => {
  const policy = (p) => mocks.getSettings.mockResolvedValue({ flatModelPolicies: { "anthropic/claude-sonnet-4-5": p } });

  it("routes a flat id in the saved order and says the order is custom", async () => {
    policy({ order: ["openrouter/anthropic/claude-sonnet-4.5"] });
    const [claude] = await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat" });
    expect(claude.offer_order).toBe("custom");
    expect(claude.members).toEqual(["openrouter/anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5"]);
  });

  it("keeps a switched-off offer listed but never a member", async () => {
    policy({ disabled: ["anthropic/claude-sonnet-4-5"] });
    const [claude] = await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat" });
    expect(claude.members).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
    expect(claude.offers.map((o) => [o.id, o.available])).toEqual([
      ["anthropic/claude-sonnet-4-5", false],
      ["openrouter/anthropic/claude-sonnet-4.5", true],
    ]);
  });

  it("drops a model whose offers are all off, except for the Models page", async () => {
    policy({ disabled: ["anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-sonnet-4.5"] });
    expect(await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat" })).toEqual([]);
    const [kept] = await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat", keepEmptyFlat: true });
    expect(kept.offers.map((o) => o.available)).toEqual([false, false]);
  });

  it("is price order when no policy is saved", async () => {
    const [claude] = await buildModelsList(["llm"], { skipDynamicFetch: true, idFormat: "flat" });
    expect(claude.offer_order).toBe("price");
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

describe("/api/flat-models", () => {
  const call = async (method, body, query = "") => {
    const { PUT, DELETE } = await import("@/app/api/flat-models/route.js");
    const req = new Request(`http://localhost/api/flat-models${query}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return method === "PUT" ? PUT(req) : DELETE(req);
  };

  it("saves one model's policy, keeps the others, and clears it when empty", async () => {
    mocks.getSettings.mockResolvedValue({ flatModelPolicies: { "x/other": { order: ["o"], disabled: [] } } });
    const res = await call("PUT", { key: "anthropic/claude-sonnet-4-5", order: ["b", "a", "b"], disabled: ["a"] });
    expect(res.status).toBe(200);
    const saved = mocks.updateSettings.mock.calls[0][0].flatModelPolicies;
    expect(saved["x/other"]).toEqual({ order: ["o"], disabled: [] });
    expect(saved["anthropic/claude-sonnet-4-5"]).toMatchObject({ order: ["b", "a"], disabled: ["a"] });

    await call("PUT", { key: "x/other", order: [], disabled: [] });
    expect(mocks.updateSettings.mock.calls[1][0].flatModelPolicies).not.toHaveProperty("x/other");
    await call("DELETE", null, "?key=x%2Fother");
    expect(mocks.updateSettings.mock.calls[2][0].flatModelPolicies).not.toHaveProperty("x/other");
  });

  it("rejects a missing key or malformed lists", async () => {
    expect((await call("PUT", { order: [] })).status).toBe(400);
    expect((await call("PUT", { key: "k", order: "a" })).status).toBe(400);
    expect((await call("PUT", { key: "k", disabled: [1] })).status).toBe(400);
    expect((await call("DELETE", null)).status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
