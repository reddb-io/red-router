import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("@/models", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
const { syncRemoteRouterCatalog } = await import("@/lib/remoteRouterCatalog");
const connection = () => ({
  id: "remote", apiKey: "remote-key", provider: "red-router",
  providerSpecificData: { baseUrl: "http://remote.test/v1" },
});
const reply = (models) => new Response(JSON.stringify({ data: models }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("persistent remote router catalog", () => {
  it("imports all remote provider namespaces and combo IDs without manual registration", async () => {
    const c = connection();
    db.getProviderConnectionById.mockResolvedValue(c);
    const models = [
      { id: "cc/claude-fable-5.1", capabilities: { tools: true, contextWindow: 200000 } },
      { id: "openai/gpt-example" }, { id: "my-combo" },
    ];
    const fetcher = vi.fn(async () => reply([...models, models[0], {}, { id: 123 }]));
    vi.stubGlobal("fetch", fetcher);
    expect((await syncRemoteRouterCatalog(c)).models).toEqual(models);
    expect(db.updateProviderConnection).toHaveBeenCalledWith("remote", {
      providerSpecificData: { ...c.providerSpecificData, discoveredModels: models, modelsSyncedAt: expect.any(String) },
    });
    expect(fetcher).toHaveBeenCalledWith("http://remote.test/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer remote-key", "x-rr-internal-models-fetch": "1" }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("uses the persisted catalog without network access until refresh is due", async () => {
    const c = connection();
    c.providerSpecificData = { ...c.providerSpecificData, discoveredModels: [{ id: "cc/claude-fable-5.1" }], modelsSyncedAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn());
    expect((await syncRemoteRouterCatalog(c)).models).toEqual(c.providerSpecificData.discoveredModels);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reconciles additions and removals including a successfully empty catalog", async () => {
    const c = connection();
    c.providerSpecificData.discoveredModels = [{ id: "old-model" }];
    db.getProviderConnectionById.mockResolvedValue(c);
    vi.stubGlobal("fetch", vi.fn(async () => reply([])));
    expect((await syncRemoteRouterCatalog(c)).models).toEqual([]);
    expect(db.updateProviderConnection.mock.calls[0][1].providerSpecificData.discoveredModels).toEqual([]);
  });

  it.each(["offline", "malformed"])("preserves saved models when remote is %s and reports the failure", async (failure) => {
    const c = connection();
    c.providerSpecificData.discoveredModels = [{ id: "cc/claude-fable-5.1" }];
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "offline") throw new Error("Network unavailable");
      return new Response(JSON.stringify({ error: "broken" }));
    }));
    expect(await syncRemoteRouterCatalog(c)).toMatchObject({ models: c.providerSpecificData.discoveredModels, warning: expect.any(String), cached: true });
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not overwrite credentials or resurrect a connection changed during sync", async () => {
    const c = connection();
    db.getProviderConnectionById.mockResolvedValue({ ...c, apiKey: "new-key" });
    vi.stubGlobal("fetch", vi.fn(async () => reply([{ id: "old-key-model" }])));
    await syncRemoteRouterCatalog(c);
    expect(db.updateProviderConnection).not.toHaveBeenCalled();
  });
});
