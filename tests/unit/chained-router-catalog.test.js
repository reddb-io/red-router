// Catalogs through chained RedRouters: a RedRouter connection's System One (and chat)
// models are listed under its prefix with a `route` naming every router hop; entries
// that loop back or exceed the hop limit are dropped. The upstream router's catalog
// is stubbed as that router would serve it (its own re-exposed entries carry `route`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let buildModelsList;
let catalogRequestChain;
let resolveRedRouterHop;
let routerConnection;
let RED_ROUTER_INSTANCE_ID;
let RED_ROUTER_MAX_HOPS;
let routableRemoteEntries;

const HOME = "http://home.test";
const HOME_INSTANCE = "rr-home";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-chained-catalog-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  routerConnection = await db.createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    name: "Home router",
    apiKey: "k-home",
    providerSpecificData: { baseUrl: `${HOME}/v1` },
  });
  ({ buildModelsList, catalogRequestChain } = await import("../../src/app/api/v1/models/route.js"));
  ({ resolveRedRouterHop } = await import("../../src/sse/services/model.js"));
  ({ RED_ROUTER_INSTANCE_ID, RED_ROUTER_MAX_HOPS, routableRemoteEntries } = await import("../../open-sse/config/redRouter.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  // Forget the cached remote catalogs between cases.
  await db.updateProviderConnection(routerConnection.id, { providerSpecificData: { baseUrl: `${HOME}/v1` } });
});

const hop = (instance) => ({ id: "red-router", name: "RedRouter", prefix: "red-router", instance });
const zen = { id: "opencode-zen", name: "OpenCode Zen" };

// Home's /v1/models/systemone: one model of its own, and what it re-exposes from
// the routers behind it (office, then lab behind office).
const homeSystemOne = () => [
  { id: "opencode-zen/jev-1.13", name: "JEV 1.13", provider: zen, aliases: ["ocz/jev-1.13"] },
  { id: "red-router/opencode-go/jev-1.13", name: "JEV 1.13", provider: zen, via: "red-router", route: [hop("rr-office")] },
  { id: "red-router/red-router/openrouter/typesafe/jev-1.13", name: "JEV 1.13", provider: { id: "openrouter", name: "OpenRouter" }, via: "red-router", route: [hop("rr-office"), hop("rr-lab")] },
  // Office reaches back to this router: a cycle.
  { id: "red-router/red-router/typesafe-ai/jev-latest", provider: { id: "typesafe-ai" }, via: "red-router", route: [hop("rr-office"), hop(RED_ROUTER_INSTANCE_ID)] },
  // Four more routers behind home: five hops from here.
  { id: "red-router/red-router/red-router/red-router/typesafe-ai/jev-latest", provider: { id: "typesafe-ai" }, via: "red-router", route: [hop("rr-1"), hop("rr-2"), hop("rr-3"), hop("rr-4")] },
];

function stubHome(catalogs) {
  const fetchMock = vi.fn(async (url) => {
    const models = catalogs[String(url)];
    return models
      ? Response.json({ object: "list", data: models }, { headers: { "x-red-router-instance": HOME_INSTANCE } })
      : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const remoteIds = (models) => models.filter((m) => m.via === "red-router").map((m) => m.id);

describe("/v1/models/systemone through chained RedRouters", () => {
  it("lists the upstream router's System One models, one prefix per hop, with the route", async () => {
    const fetchMock = stubHome({ [`${HOME}/v1/models/systemone`]: homeSystemOne() });

    const models = await buildModelsList(["systemone"]);

    expect(remoteIds(models)).toEqual([
      "red-router/opencode-zen/jev-1.13",
      "red-router/red-router/opencode-go/jev-1.13",
      "red-router/red-router/red-router/openrouter/typesafe/jev-1.13",
    ]);
    const [own, depth2, depth3] = models.filter((m) => m.via === "red-router");
    expect(own).toMatchObject({
      name: "JEV 1.13",
      provider: zen,
      aliases: ["red-router/ocz/jev-1.13"],
      route: [{ id: "red-router", prefix: "red-router", instance: HOME_INSTANCE }],
    });
    expect(depth2.route.map((h) => h.instance)).toEqual([HOME_INSTANCE, "rr-office"]);
    expect(depth3.route.map((h) => h.instance)).toEqual([HOME_INSTANCE, "rr-office", "rr-lab"]);
    expect(depth3.provider).toMatchObject({ id: "openrouter" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${HOME}/v1/models/systemone`);
    expect(init.headers.Authorization).toBe("Bearer k-home");
    expect(init.headers["x-red-router-chain"]).toBe(RED_ROUTER_INSTANCE_ID);
  });

  it("caches the System One catalog apart from the chat one", async () => {
    const fetchMock = stubHome({ [`${HOME}/v1/models/systemone`]: homeSystemOne() });

    const first = remoteIds(await buildModelsList(["systemone"]));
    const second = remoteIds(await buildModelsList(["systemone"]));

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const saved = (await db.getProviderConnectionById(routerConnection.id)).providerSpecificData;
    expect(saved.discoveredSystemOneModels).toHaveLength(homeSystemOne().length);
    expect(saved.systemOneModelsInstanceId).toBe(HOME_INSTANCE);
    expect(saved.discoveredModels).toBeUndefined();
  });

  it("drops routes through routers the request already passed, and those past the hop limit", async () => {
    const fetchMock = stubHome({ [`${HOME}/v1/models/systemone`]: homeSystemOne() });

    // Lab asked: lab's own route is a cycle, and two hops are already spent.
    const models = await buildModelsList(["systemone"], { chain: ["rr-lab"] });

    expect(remoteIds(models)).toEqual([
      "red-router/opencode-zen/jev-1.13",
      "red-router/red-router/opencode-go/jev-1.13",
    ]);
    expect(fetchMock.mock.calls[0][1].headers["x-red-router-chain"]).toBe(`rr-lab,${RED_ROUTER_INSTANCE_ID}`);
    // A catalog cut to one chain is not saved as the connection's catalog.
    expect((await db.getProviderConnectionById(routerConnection.id)).providerSpecificData.discoveredSystemOneModels).toBeUndefined();
  });

  it("fetches no upstream router when the request already passed through this one", async () => {
    const fetchMock = stubHome({ [`${HOME}/v1/models/systemone`]: homeSystemOne() });

    const models = await buildModelsList(["systemone"], { chain: ["rr-edge", RED_ROUTER_INSTANCE_ID] });

    expect(remoteIds(models)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches no upstream router once the chain holds the hop limit", async () => {
    const fetchMock = stubHome({ [`${HOME}/v1/models/systemone`]: homeSystemOne() });
    const full = Array.from({ length: RED_ROUTER_MAX_HOPS }, (_, i) => `rr-${i}`);

    expect(remoteIds(await buildModelsList(["systemone"], { chain: full }))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops everything from an upstream router that is this router", () => {
    expect(routableRemoteEntries(homeSystemOne(), { remoteInstance: RED_ROUTER_INSTANCE_ID, chain: [RED_ROUTER_INSTANCE_ID] })).toEqual([]);
  });
});

describe("/v1/models through chained RedRouters", () => {
  it("lists chat models re-exposed by the upstream router, loops dropped", async () => {
    const claude = { id: "claude", name: "Claude" };
    const fetchMock = stubHome({
      [`${HOME}/v1/models`]: [
        { id: "cc/claude-fable-5.1", name: "Claude Fable 5.1", provider: claude },
        { id: "red-router/cc/claude-fable-5.1", name: "Claude Fable 5.1", provider: claude, via: "red-router", route: [hop("rr-office")] },
        { id: "red-router/red-router/cc/claude-fable-5.1", provider: claude, via: "red-router", route: [hop("rr-office"), hop(RED_ROUTER_INSTANCE_ID)] },
      ],
    });

    const models = await buildModelsList(["llm"]);

    expect(remoteIds(models)).toEqual(["red-router/cc/claude-fable-5.1", "red-router/red-router/cc/claude-fable-5.1"]);
    const nested = models.find((m) => m.id === "red-router/red-router/cc/claude-fable-5.1");
    expect(nested.provider).toMatchObject(claude);
    expect(nested.route.map((h) => h.instance)).toEqual([HOME_INSTANCE, "rr-office"]);
    expect(fetchMock.mock.calls[0][1].headers["x-red-router-chain"]).toBe(RED_ROUTER_INSTANCE_ID);
  });

  it("reads the hop chain of a catalog request; an older router's fetch skips upstream routers", () => {
    const request = (headers) => new Request("http://router.test/v1/models", { headers });

    expect(catalogRequestChain(request({ "x-rr-internal-models-fetch": "1" }))).toEqual({ chain: [], skipDynamicFetch: true });
    expect(catalogRequestChain(request({ "x-rr-internal-models-fetch": "1", "x-red-router-chain": "rr-a, rr-b" })))
      .toEqual({ chain: ["rr-a", "rr-b"], skipDynamicFetch: false });
    expect(catalogRequestChain(request({}))).toEqual({ chain: [], skipDynamicFetch: false });
  });
});

describe("router hops under a connection prefix", () => {
  it("resolves the hop to that connection and leaves the rest for the next router", async () => {
    const office = await db.createProviderConnection({
      provider: "red-router",
      authType: "apikey",
      name: "Office router",
      apiKey: "k-office",
      providerSpecificData: { baseUrl: "http://office.test/v1", prefix: "office" },
    });
    try {
      expect(await resolveRedRouterHop("office/red-router/opencode-go/jev-1.13"))
        .toEqual({ model: "red-router/opencode-go/jev-1.13", connectionIds: [office.id] });
      expect(await resolveRedRouterHop("red-router/opencode-go/jev-1.13"))
        .toEqual({ model: "opencode-go/jev-1.13", connectionIds: null });
    } finally {
      await db.deleteProviderConnection(office.id);
    }
  });
});
