import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { CatalogPayload } from "../../../src/app/api/v1/models/catalogCache.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-catalog-cache-auth-"));
process.env.DATA_DIR = dir;
const originalTimeout = process.env.CATALOG_BUILD_TIMEOUT_MS;
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const keys = await import("../../../src/lib/db/apiKeys.ts");
const cache = await import("../../../src/app/api/v1/models/catalogCache.ts");
const { invalidateModelCatalogCache } = await import("../../../src/lib/db/readCache.ts");

beforeEach(() => {
  cache.__resetCatalogBuilderRunsForTest();
  process.env.CATALOG_BUILD_TIMEOUT_MS = "20";
});
after(() => {
  cache.__resetCatalogBuilderRunsForTest();
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
  if (originalTimeout === undefined) delete process.env.CATALOG_BUILD_TIMEOUT_MS;
  else process.env.CATALOG_BUILD_TIMEOUT_MS = originalTimeout;
});

const headers = { corsHeaders: {}, diagnosticHeaders: {} };
const request = (key = "fixture") =>
  new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${key}` } });
const payload = (id = "private-model"): CatalogPayload => ({
  body: JSON.stringify({ object: "list", data: [{ id }] }),
  headers: { "content-type": "application/json" },
  status: 200,
  cacheTTL: 60_000,
});
const pending = () => new Promise<CatalogPayload>(() => {});

test("last-good fallback is bounded by age and catalog generation", async () => {
  const req = request();
  await cache.resolveCachedCatalogResponse(req, headers, async () => payload());
  cache.__setCatalogCacheEntryForTest(req, {
    body: "temporary failure",
    headers: {},
    status: 503,
    expiresAt: Date.now() - 1,
  });
  const safe = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(safe.status, 200);
  assert.equal(safe.headers.get("x-omniroute-catalog"), "last-good");

  cache.__expireCatalogCacheForTest(cache.CATALOG_STALE_WHILE_REVALIDATE_MS + 1);
  const old = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(old.status, 503);
  assert.equal((await old.text()).includes("private-model"), false);

  invalidateModelCatalogCache();
  const changed = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(changed.status, 503);
  assert.equal((await changed.text()).includes("private-model"), false);
});

test("a timed-out refresh after key revocation or connection disable never serves prior inventory", async () => {
  const connection = await providers.createProviderConnection({
    provider: "red-router",
    isActive: true,
    authType: "apikey",
    apiKey: "fixture-upstream",
    providerSpecificData: { baseUrl: "https://remote.example/v1", autoFetchModels: false },
  });
  const key = await keys.createApiKey("Cache scope", "tests", [], {
    allowedConnections: [String(connection.id)],
  });
  const req = request(key.key);
  await cache.resolveCachedCatalogResponse(req, headers, async () => payload());
  await providers.updateProviderConnection(String(connection.id), { isActive: false });
  const disabled = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.text()).includes("private-model"), false);

  await providers.updateProviderConnection(String(connection.id), { isActive: true });
  await cache.resolveCachedCatalogResponse(req, headers, async () => payload());
  await keys.revokeApiKey(key.id);
  const revoked = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(revoked.status, 503);
  assert.equal((await revoked.text()).includes("private-model"), false);
});

test("a build completed after a policy write cannot return or cache its old projection", async () => {
  let finish!: (value: CatalogPayload) => void;
  const old = cache.resolveCachedCatalogResponse(
    request(),
    headers,
    () => new Promise((resolve) => (finish = resolve))
  );
  invalidateModelCatalogCache();
  finish(payload());
  const obsolete = await old;
  assert.equal(obsolete.status, 503);
  assert.equal((await obsolete.text()).includes("private-model"), false);
  const current = await cache.resolveCachedCatalogResponse(request(), headers, async () =>
    payload("new")
  );
  assert.equal((await current.json()).data[0].id, "new");
});

test("key lifecycle writes invalidate stored projections, including permission updates and rotation", async () => {
  const mutations: Array<[string, (id: string) => Promise<unknown>]> = [
    ["delete", keys.deleteApiKey],
    ["expiry", (id) => keys.setApiKeyExpiry(id, "2000-01-01T00:00:00.000Z")],
    ["inactive", (id) => keys.updateApiKeyPermissions(id, { isActive: false })],
    ["banned", (id) => keys.updateApiKeyPermissions(id, { isBanned: true })],
    ["scopes", (id) => keys.updateApiKeyPermissions(id, { scopes: ["manage"] })],
    ["rotation", keys.regenerateApiKey],
  ];
  for (const [name, mutate] of mutations) {
    cache.__resetCatalogBuilderRunsForTest();
    const key = await keys.createApiKey(name, "tests");
    const req = request(key.key);
    await cache.resolveCachedCatalogResponse(req, headers, async () => payload());
    await mutate(key.id);
    const response = await cache.resolveCachedCatalogResponse(req, headers, pending);
    assert.equal(response.status, 503, name);
    assert.equal((await response.text()).includes("private-model"), false, name);
  }
});

test("a long builder TTL cannot extend the successful-fallback age ceiling", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const req = request();
  await cache.resolveCachedCatalogResponse(req, headers, async () => ({
    ...payload(),
    cacheTTL: 24 * 60 * 60 * 1000,
  }));
  now += cache.CATALOG_CACHE_TTL_MS_DEFAULT + cache.CATALOG_STALE_WHILE_REVALIDATE_MS + 1;
  const response = await cache.resolveCachedCatalogResponse(req, headers, pending);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private-model"), false);
});

test("a cached body with a different generation is never returned even before expiry", async () => {
  const req = request();
  cache.__setCatalogCacheEntryForTest(req, {
    body: payload().body,
    headers: {},
    status: 200,
    expiresAt: Date.now() + 60_000,
    generation: -1,
  });
  const response = await cache.resolveCachedCatalogResponse(req, headers, async () =>
    payload("current")
  );
  assert.equal((await response.json()).data[0].id, "current");
});

test("many credential/page projections cannot grow memo or in-flight maps without bound", async () => {
  for (let index = 0; index < cache.CATALOG_CACHE_MAX_ENTRIES + 12; index++) {
    const response = await cache.resolveCachedCatalogResponse(
      request(`key-${index}`),
      headers,
      async () => payload(String(index))
    );
    assert.equal(response.status, 200);
  }
  const memo = cache.__getCatalogCacheSizesForTest();
  assert.ok(memo.cache <= cache.CATALOG_CACHE_MAX_ENTRIES);
  assert.ok(memo.lastGood <= cache.CATALOG_CACHE_MAX_ENTRIES);

  const waiting: Promise<Response>[] = [];
  for (let index = 0; index <= cache.CATALOG_IN_FLIGHT_MAX_ENTRIES; index++) {
    waiting.push(cache.resolveCachedCatalogResponse(request(`pending-${index}`), headers, pending));
  }
  assert.ok(cache.__getCatalogCacheSizesForTest().inFlight <= cache.CATALOG_IN_FLIGHT_MAX_ENTRIES);
  const responses = await Promise.all(waiting);
  assert.equal(responses.at(-1)?.status, 503);
  assert.equal(responses.at(-1)?.headers.get("x-omniroute-catalog"), "catalog_capacity_exceeded");
});
