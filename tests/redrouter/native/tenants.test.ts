import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install: tenants, their users, and the tenant boundary on API keys.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-tenants-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "tenants-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const { createApiKey, getApiKeyMetadata, clearApiKeyCaches } =
  await import("../../../src/lib/db/apiKeys.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const { TENANT_NO_CONNECTIONS_ID } = await import("../../../src/lib/db/tenantScope.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDbInstance();
  db.prepare("DELETE FROM tenant_shared_resources").run();
  db.prepare("DELETE FROM tenant_users").run();
  db.prepare("DELETE FROM api_keys").run();
  db.prepare("DELETE FROM provider_connections").run();
  db.prepare("DELETE FROM combos").run();
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  clearApiKeyCaches();
});

async function connection(name: string, tenantId?: string): Promise<string> {
  const created = (await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  if (tenantId) tenants.assignResourcesToTenant(tenantId, { connectionIds: [created.id] });
  return created.id;
}

async function combo(name: string, tenantId?: string): Promise<string> {
  const created = (await combosDb.createCombo({
    id: `combo-${name}`,
    name,
    models: [],
  } as never)) as { id: string };
  if (tenantId) tenants.assignResourcesToTenant(tenantId, { comboIds: [created.id] });
  return created.id;
}

async function keyFor(tenantSlug: string | null, scopes: string[] = []) {
  const created = await createApiKey("k", "tenants-test-machine", scopes);
  if (tenantSlug) {
    const tenant = tenants.getTenant(tenantSlug)!;
    if (!tenant.isDefault) tenants.assignApiKeysToTenant(tenant.id, [created.id]);
  }
  clearApiKeyCaches();
  return created;
}

test("a fresh install has the default tenant 'red' and everything belongs to it", async () => {
  const red = tenants.getTenant("red");
  assert.ok(red);
  assert.equal(red.isDefault, true);
  assert.equal(red.disabled, false);
  const key = await keyFor(null);
  const id = await connection("first");
  const row = getDbInstance().prepare("SELECT tenant_id FROM provider_connections WHERE id = ?");
  assert.equal((row.get(id) as { tenant_id: string }).tenant_id, "red");
  assert.equal((await getApiKeyMetadata(key.key))?.tenantId, "red");
});

test("tenant slugs are validated and unique", () => {
  assert.throws(() => tenants.createTenant({ slug: "A B" }), /slug/);
  assert.throws(() => tenants.createTenant({ slug: "x" }), /slug/);
  tenants.createTenant({ slug: "acme", name: "Acme" });
  assert.throws(() => tenants.createTenant({ slug: "acme" }), /already exists/);
  assert.throws(() => tenants.createTenant({ slug: "red" }), /already exists/);
});

test("the default tenant cannot be disabled or deleted; a tenant that owns things cannot be deleted", async () => {
  assert.throws(() => tenants.updateTenant("red", { disabled: true }), /default tenant/);
  assert.throws(() => tenants.deleteTenant("red"), /default tenant/);
  const acme = tenants.createTenant({ slug: "acme" });
  await connection("c1", acme.id);
  assert.throws(() => tenants.deleteTenant(acme.id), /still owns/);
});

test("users: e-mail is unique across tenants and roles are checked", () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const globex = tenants.createTenant({ slug: "globex" });
  const admin = tenants.createTenantUser(acme.id, { email: "Boss@Acme.io", role: "admin" });
  assert.equal(admin.email, "boss@acme.io");
  assert.equal(admin.role, "admin");
  assert.equal(admin.hasPassword, false);
  assert.throws(
    () => tenants.createTenantUser(globex.id, { email: "boss@acme.io" }),
    /already exists/
  );
  assert.throws(() => tenants.createTenantUser(acme.id, { email: "not-an-email" }), /e-mail/);
  assert.throws(
    () => tenants.createTenantUser(acme.id, { email: "x@acme.io", role: "root" }),
    /Role/
  );
  const promoted = tenants.updateTenantUser(
    acme.id,
    tenants.createTenantUser(acme.id, { email: "u@acme.io" }).id,
    {
      role: "admin",
    }
  );
  assert.equal(promoted.role, "admin");
  // A user is only reachable through its own tenant.
  assert.throws(
    () => tenants.updateTenantUser(globex.id, promoted.id, { disabled: true }),
    /not found/
  );
  const summary = tenants.listTenants().find((t) => t.id === acme.id)!;
  assert.equal(summary.admins, 2);
  assert.equal(summary.users, 2);
});

test("a tenant key only sees its own connections and combos", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const globex = tenants.createTenant({ slug: "globex" });
  const redConn = await connection("red-conn");
  const acmeConn = await connection("acme-conn", acme.id);
  const globexConn = await connection("globex-conn", globex.id);
  await combo("red-combo");
  await combo("acme-combo", acme.id);

  const acmeKey = await keyFor("acme");
  const meta = await getApiKeyMetadata(acmeKey.key);
  assert.equal(meta?.tenantId, acme.id);
  assert.deepEqual(meta?.allowedConnections, [acmeConn]);
  assert.deepEqual(meta?.allowedCombos, ["acme-combo"]);
  assert.ok(!meta?.allowedConnections.includes(redConn));
  assert.ok(!meta?.allowedConnections.includes(globexConn));
});

test("a tenant with no connections gets a sentinel, never the empty 'unrestricted' list", async () => {
  tenants.createTenant({ slug: "acme" });
  await connection("red-conn");
  const meta = await getApiKeyMetadata((await keyFor("acme")).key);
  assert.deepEqual(meta?.allowedConnections, [TENANT_NO_CONNECTIONS_ID]);
  assert.deepEqual(meta?.allowedCombos, []);
});

test("the default tenant's keys are unchanged until another tenant owns a private account", async () => {
  const redConn = await connection("red-conn");
  const redKey = await keyFor(null);
  assert.deepEqual((await getApiKeyMetadata(redKey.key))?.allowedConnections, []);

  const acme = tenants.createTenant({ slug: "acme" });
  const acmeConn = await connection("acme-conn", acme.id);
  const scoped = (await getApiKeyMetadata(redKey.key))?.allowedConnections ?? [];
  assert.ok(scoped.includes(redConn));
  assert.ok(scoped.includes("noauth"), "keyless providers stay available to the default tenant");
  assert.ok(!scoped.includes(acmeConn), "red traffic must not burn another tenant's account");
});

test("a shared connection is usable by every tenant; moving it clears the sharing", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const globex = tenants.createTenant({ slug: "globex" });
  const shared = await connection("shared-conn", acme.id);
  tenants.setResourceShared("connection", shared, true);
  assert.ok(
    (await getApiKeyMetadata((await keyFor("globex")).key))?.allowedConnections.includes(shared)
  );

  tenants.assignResourcesToTenant(globex.id, { connectionIds: [shared] });
  assert.deepEqual(tenants.listSharedResourceIds("connection"), []);
  assert.ok(
    (await getApiKeyMetadata((await keyFor("acme")).key))?.allowedConnections.every(
      (id) => id !== shared
    )
  );
});

test("a key's own allow-list can only narrow what the tenant permits", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const a = await connection("a", acme.id);
  const foreign = await connection("foreign");
  const key = await createApiKey("k", "tenants-test-machine", [], {
    allowedConnections: [a, foreign],
  });
  tenants.assignApiKeysToTenant(acme.id, [key.id]);
  clearApiKeyCaches();
  assert.deepEqual((await getApiKeyMetadata(key.key))?.allowedConnections, [a]);
});

test("a tenant key never carries instance-wide scopes", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const manager = await createApiKey("m", "tenants-test-machine", ["manage"]);
  assert.throws(() => tenants.assignApiKeysToTenant(acme.id, [manager.id]), /whole instance/);
  const mcp = await createApiKey("p", "tenants-test-machine", ["mcp:connect"]);
  assert.throws(() => tenants.assignApiKeysToTenant(acme.id, [mcp.id]), /whole instance/);

  // Even if the row is edited underneath, the effective scopes are stripped on read.
  const key = await keyFor("acme");
  getDbInstance()
    .prepare("UPDATE api_keys SET scopes = ? WHERE id = ?")
    .run(JSON.stringify(["manage", "admin", "mcp:connect"]), key.id);
  clearApiKeyCaches();
  assert.deepEqual((await getApiKeyMetadata(key.key))?.scopes, []);
});

test("disabling a tenant stops its keys; re-enabling restores them", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  await connection("c", acme.id);
  const key = await keyFor("acme");
  assert.equal((await getApiKeyMetadata(key.key))?.isActive, true);
  tenants.updateTenant(acme.id, { disabled: true });
  const off = await getApiKeyMetadata(key.key);
  assert.equal(off?.isActive, false);
  assert.deepEqual(off?.allowedConnections, [TENANT_NO_CONNECTIONS_ID]);
  tenants.updateTenant(acme.id, { disabled: false });
  assert.equal((await getApiKeyMetadata(key.key))?.isActive, true);
});

test("credential selection honours the tenant boundary end to end", async () => {
  const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
  const acme = tenants.createTenant({ slug: "acme" });
  tenants.createTenant({ slug: "empty" });
  const redConn = await connection("red-conn");
  const acmeConn = await connection("acme-conn", acme.id);

  const acmeMeta = await getApiKeyMetadata((await keyFor("acme")).key);
  const acmePick = (await getProviderCredentials("openai", null, acmeMeta!.allowedConnections)) as {
    connectionId?: string;
  } | null;
  assert.equal(acmePick?.connectionId, acmeConn);

  const emptyMeta = await getApiKeyMetadata((await keyFor("empty")).key);
  const emptyPick = (await getProviderCredentials(
    "openai",
    null,
    emptyMeta!.allowedConnections
  )) as { connectionId?: string; blockedByKeyPolicy?: boolean } | null;
  assert.equal(emptyPick?.blockedByKeyPolicy, true);
  assert.equal(emptyPick?.connectionId, undefined, "no account of another tenant is handed out");

  const redMeta = await getApiKeyMetadata((await keyFor(null)).key);
  const redPick = (await getProviderCredentials("openai", null, redMeta!.allowedConnections)) as {
    connectionId?: string;
  } | null;
  assert.equal(redPick?.connectionId, redConn);
});

test("the resource listing shows each owner and never a secret", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  const conn = await connection("listed", acme.id);
  await combo("listed-combo");
  tenants.setResourceShared("connection", conn, true);
  const key = await keyFor("acme");
  const all = tenants.listAllTenantResources();
  const found = all.connections.find((row) => row.id === conn);
  assert.equal(found?.tenantId, acme.id);
  assert.equal(found?.shared, true);
  assert.equal(all.combos.find((row) => row.name === "listed-combo")?.tenantId, "red");
  assert.equal(all.apiKeys.find((row) => row.id === key.id)?.tenantId, acme.id);
  assert.ok(!JSON.stringify(all).includes(key.key), "the key value must not be listed");
  assert.ok(!JSON.stringify(all).includes("sk-listed"), "connection secrets must not be listed");
});
