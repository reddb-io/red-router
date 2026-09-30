import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// /v1/models with the "transparent" mode on and off, on a real database with real connections.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-routing-catalog-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-routing-catalog";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "routing-catalog-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const rows = await import("../../../src/lib/db/routingPolicy.ts");
const { createApiKey, clearApiKeyCaches } = await import("../../../src/lib/db/apiKeys.ts");
const { getUnifiedModelsResponse } = await import("../../../src/app/api/v1/models/catalog.ts");
const { markTransparentCatalogRequest } =
  await import("../../../src/app/api/v1/models/catalogTransparency.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

type Entry = { id: string; owned_by: string; root?: string; type?: string };

async function connect(provider: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: provider,
    apiKey: `sk-${provider}`,
    isActive: true,
    testStatus: "active",
  });
}

async function list(apiKey?: string, mark = false): Promise<Entry[]> {
  const request = new Request("http://localhost/v1/models", {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  const res = await getUnifiedModelsResponse(
    mark ? markTransparentCatalogRequest(request) : request
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { data: Entry[] }).data;
}

const rootsOf = (data: Entry[], root: string) =>
  data.filter((m) => (m.root ?? m.id.split("/").pop()) === root);

beforeEach(async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM tenant_routing_policy").run();
  db.prepare("DELETE FROM api_keys").run();
  db.prepare("DELETE FROM provider_connections").run();
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    transparentModels: true,
    providerPriority: [],
    delegateRoutingToTenants: false,
    requireLogin: false,
  });
  invalidateDbCache();
  clearApiKeyCaches();
  await connect("openai");
  await connect("aimlapi");
});

test("transparent (the default): a model offered by two providers is listed once per provider, with its prefix", async () => {
  const data = await list();
  const gpt = rootsOf(data, "gpt-4o");
  assert.ok(gpt.length >= 2, `expected gpt-4o from both providers, got ${gpt.map((m) => m.id)}`);
  assert.ok(
    gpt.every((m) => m.id.includes("/")),
    "every id carries its provider"
  );
  assert.ok(gpt.some((m) => m.owned_by === "openai"));
});

test("transparent off: each chat model is listed once, bare, and the provider is not revealed", async () => {
  await updateSettings({ transparentModels: false, providerPriority: ["aimlapi", "openai"] });
  const data = await list();
  const gpt = data.filter((m) => m.id === "gpt-4o");
  assert.equal(gpt.length, 1);
  assert.equal(gpt[0].owned_by, "red-router");
  assert.ok(!data.some((m) => m.id === "openai/gpt-4o" || m.id === "aimlapi/gpt-4o"));
  const providerChat = data.filter(
    (m) => m.owned_by !== "combo" && m.owned_by !== "red-router" && (!m.type || m.type === "chat")
  );
  assert.deepEqual(
    providerChat.map((m) => m.id),
    [],
    "no chat model keeps a provider prefix"
  );
});

test("other modalities are not touched yet", async () => {
  const transparent = (await list())
    .filter((m) => m.type && m.type !== "chat")
    .map((m) => m.id)
    .sort();
  await updateSettings({ transparentModels: false });
  const bare = (await list())
    .filter((m) => m.type && m.type !== "chat")
    .map((m) => m.id)
    .sort();
  assert.deepEqual(bare, transparent);
});

test("flipping the setting shows on the very next read (the catalog cache follows it)", async () => {
  assert.ok((await list()).some((m) => m.id === "openai/gpt-4o"));
  await updateSettings({ transparentModels: false });
  assert.ok(!(await list()).some((m) => m.id === "openai/gpt-4o"));
  await updateSettings({ transparentModels: true });
  assert.ok((await list()).some((m) => m.id === "openai/gpt-4o"));
});

test("the router's own lookup always sees the transparent list", async () => {
  await updateSettings({ transparentModels: false });
  const data = await list(undefined, true);
  assert.ok(data.some((m) => m.id === "openai/gpt-4o"));
  // ...and it never poisons the public entry.
  assert.ok(!(await list()).some((m) => m.id === "openai/gpt-4o"));
});

test("the owner's pin for a tenant changes what that tenant's key lists, not anyone else's", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  await providersDb
    .createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "acme-openai",
      apiKey: "sk-acme",
      isActive: true,
      testStatus: "active",
    })
    .then((c: { id: string }) =>
      tenants.assignResourcesToTenant(acme.id, { connectionIds: [c.id] })
    );
  const acmeKey = await createApiKey("acme", "routing-machine");
  tenants.assignApiKeysToTenant(acme.id, [acmeKey.id]);
  const redKey = await createApiKey("red", "routing-machine");
  clearApiKeyCaches();

  rows.setTenantRoutingSide(acme.id, "owner", { transparent: false });
  const forAcme = await list(acmeKey.key);
  assert.ok(
    forAcme.some((m) => m.id === "gpt-4o"),
    "the pinned tenant sees bare names"
  );
  assert.ok(
    !forAcme.some(
      (m) => m.id.includes("/") && m.owned_by === "openai" && (!m.type || m.type === "chat")
    ),
    "no chat model keeps its provider prefix"
  );
  const forRed = await list(redKey.key);
  assert.ok(
    forRed.some((m) => m.id === "openai/gpt-4o"),
    "the default tenant is unchanged"
  );
});

test("a tenant admin's choice is honored only after the owner delegates", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const conn = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "acme-openai",
    apiKey: "sk-acme",
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  tenants.assignResourcesToTenant(acme.id, { connectionIds: [conn.id] });
  const key = await createApiKey("acme", "routing-machine");
  tenants.assignApiKeysToTenant(acme.id, [key.id]);
  clearApiKeyCaches();

  rows.setTenantRoutingSide(acme.id, "tenant", { transparent: false });
  assert.ok(
    (await list(key.key)).some((m) => m.id === "openai/gpt-4o"),
    "not delegated: the tenant's choice is ignored"
  );
  await updateSettings({ delegateRoutingToTenants: true });
  assert.ok(
    (await list(key.key)).some((m) => m.id === "gpt-4o"),
    "delegated: it applies"
  );
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: true });
  assert.ok(
    (await list(key.key)).some((m) => m.id === "openai/gpt-4o"),
    "the owner's pin wins again"
  );
});
