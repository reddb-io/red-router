import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A RedRouter v0.33.0 install lives in <DATA_DIR>/data.sqlite. The fixture below is built from
// that schema (src/lib/db/schema.js at the tag), so no binary fixture is committed.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-friday-import-"));
process.env.DATA_DIR = dataDir;
const { tryOpenSync } = await import("../../../src/lib/db/adapters/driverFactory.ts");
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getKeyQuotaLimits } = await import("../../../src/lib/db/keyQuota.ts");
const {
  fridayImportPending,
  importFridayData,
  mapFridayProxyPools,
  collectFridayProxyBindings,
  FRIDAY_IMPORT_MARKER,
  FRIDAY_IMPORT_REPORT,
} = await import("../../../src/lib/db/fridayImport.ts");

const HASH = "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
const sourceFile = join(dataDir, "data.sqlite");

function buildFridayDatabase() {
  const db = tryOpenSync(sourceFile);
  assert.ok(db, "a SQLite driver is available");
  db.exec(`
    CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT,
      email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT, createdAt TEXT,
      updatedAt TEXT, owner TEXT);
    CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
      isActive INTEGER DEFAULT 1, createdAt TEXT, allowedConnectionIds TEXT, tags TEXT, owner TEXT,
      modelAccess TEXT, limits TEXT, modelIdFormat TEXT, role TEXT);
    CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, models TEXT NOT NULL,
      owner TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE proxyPools (id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT,
      data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp TEXT, provider TEXT, model TEXT,
      connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER,
      cost REAL, status TEXT, tokens TEXT, meta TEXT);
  `);
  const now = "2026-09-25T12:00:00.000Z";
  db.prepare("INSERT INTO providerConnections VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "conn-oauth", "claude", "oauth", "Claude", "me@example.test", 1, 1,
    JSON.stringify({
      accessToken: "at", refreshToken: "rt", expiresAt: "2026-10-01T00:00:00.000Z", scope: "x",
      testStatus: "active", "modelLock_claude-opus-5-5": 123, unknownFridayField: true,
      providerSpecificData: { proxyPoolId: "pool-relay" },
    }),
    now, now, "alice@example.test"
  );
  db.prepare("INSERT INTO providerConnections VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "conn-key", "openrouter", "apikey", "OR", null, 2, 1,
    JSON.stringify({
      apiKey: "sk-or-fixture",
      providerSpecificData: { region: "us", proxyPoolId: "pool-http" },
    }),
    now, now, null
  );
  db.prepare("INSERT INTO proxyPools VALUES (?,?,?,?,?,?)").run(
    "pool-http", 1, "active",
    JSON.stringify({
      name: "Corp proxy", type: "http", proxyUrl: "http://alice:p%40ss@proxy.example.test:3128",
      noProxy: "localhost,.internal", strictProxy: true, testStatus: "active",
    }),
    now, now
  );
  db.prepare("INSERT INTO proxyPools VALUES (?,?,?,?,?,?)").run(
    "pool-relay", 1, "unknown",
    JSON.stringify({ name: "Edge relay", type: "vercel", proxyUrl: "https://relay.example.test" }),
    now, now
  );
  db.prepare("INSERT INTO apiKeys VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "key-admin", "sk-admin-fixture-0001", "Admin", "machine1", 1, now,
    JSON.stringify(["conn-key"]), JSON.stringify(["team-a"]), "bob@example.test",
    JSON.stringify({ mode: "allow", patterns: ["claude/*"] }),
    JSON.stringify({ rpm: 30, tokensPerDay: 5000, usdPerMonth: 12 }), "flat", "admin"
  );
  db.prepare("INSERT INTO apiKeys VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "key-off", "sk-off-fixture-0002", "Disabled", "machine1", 0, now,
    null, null, null, null, null, null, null
  );
  db.prepare("INSERT INTO combos VALUES (?,?,?,?,?,?,?)").run(
    "combo-1", "fast", null, JSON.stringify(["claude/claude-opus-5-5", "openrouter/x/y"]), "alice@example.test", now, now
  );
  db.prepare("INSERT INTO settings VALUES (1, ?)").run(
    JSON.stringify({
      password: HASH,
      requireLogin: true,
      tunnelEnabled: true,
      scopeResourcesByUser: true,
      ssoAdminEmails: ["alice@example.test"],
      oidcIssuer: "https://idp.example.test",
      oidcClientSecret: "super-secret-value",
    })
  );
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run("modelAliases", "fast-alias", JSON.stringify("claude/x"));
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run("disabledModels", "claude", JSON.stringify(["a"]));
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run(
    "disabledSharedAccounts", "bob@example.test", JSON.stringify(["conn-key"])
  );
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run(
    "customModels", "ocg|deepseek-v4.1-flash|llm",
    JSON.stringify({ providerAlias: "ocg", id: "deepseek-v4.1-flash", type: "llm", name: "DS Flash" })
  );
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run(
    "customModels", "openrouter|voice|tts",
    JSON.stringify({ providerAlias: "openrouter", id: "voice", type: "tts", name: "voice" })
  );
  db.prepare("INSERT INTO usageHistory VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    1, "2026-09-26T10:00:00.000Z", "claude", "claude-opus-5-5", "conn-oauth",
    "sk-admin-fixture-0001", "/v1/chat/completions", 10, 5, 0.01, "ok",
    JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 }), null
  );
  db.prepare("INSERT INTO usageHistory VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    2, "2026-09-26T10:01:00.000Z", "openrouter", "m", "conn-key",
    "sk-unknown", "/v1/systemone", 1, 1, 0, "error", null, null
  );
  db.close();
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a Friday install is detected, and a dry run writes nothing", async () => {
  buildFridayDatabase();
  assert.equal(fridayImportPending(dataDir), true);
  const before = sha256(sourceFile);
  const report = await importFridayData({ dataDir, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.imported.connections, 2);
  assert.equal(report.imported.apiKeys, 2);
  assert.equal(existsSync(join(dataDir, FRIDAY_IMPORT_MARKER)), false);
  assert.equal(existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).length : 0, 0);
  const row = getDbInstance().prepare("SELECT COUNT(*) AS n FROM provider_connections").get() as { n: number };
  assert.equal(row.n, 0);
  assert.equal(report.imported.proxies, 2);
  assert.equal(report.imported.proxyAssignments, 2);
  const registry = getDbInstance().prepare("SELECT COUNT(*) AS n FROM proxy_registry").get() as { n: number };
  assert.equal(registry.n, 0, "a dry run writes no proxies");
  assert.equal(sha256(sourceFile), before);
});

test("the import maps connections, keys, combos, settings and usage, and reports what is left", async () => {
  const before = sha256(sourceFile);
  const report = await importFridayData({ dataDir });
  const db = getDbInstance();

  assert.deepEqual(
    [report.imported.connections, report.imported.apiKeys, report.imported.combos, report.imported.usageHistory],
    [2, 2, 1, 2]
  );
  assert.deepEqual(report.providers, ["claude", "openrouter"]);

  const oauth = db.prepare("SELECT * FROM provider_connections WHERE id = ?").get("conn-oauth") as Record<string, unknown>;
  assert.equal(oauth.access_token, "at");
  assert.equal(oauth.refresh_token, "rt");
  assert.equal(oauth.auth_type, "oauth");
  const apikey = db.prepare("SELECT * FROM provider_connections WHERE id = ?").get("conn-key") as Record<string, unknown>;
  assert.equal(apikey.api_key, "sk-or-fixture");
  assert.deepEqual(JSON.parse(String(apikey.provider_specific_data)), { region: "us" });

  const admin = db.prepare("SELECT * FROM api_keys WHERE id = ?").get("key-admin") as Record<string, unknown>;
  assert.equal(admin.key, "sk-admin-fixture-0001");
  assert.equal(admin.key_hash, createHash("sha256").update("sk-admin-fixture-0001").digest("hex"));
  assert.equal(admin.key_prefix, "sk-admin-fix");
  assert.deepEqual(JSON.parse(String(admin.scopes)), ["manage"]);
  assert.deepEqual(JSON.parse(String(admin.allowed_connections)), ["conn-key"]);
  assert.equal(admin.model_access_mode, "restricted");
  assert.deepEqual(JSON.parse(String(admin.allowed_models)), ["claude/*"]);
  const off = db.prepare("SELECT is_active FROM api_keys WHERE id = ?").get("key-off") as { is_active: number };
  assert.equal(off.is_active, 0);

  const limits = getKeyQuotaLimits("key-admin");
  assert.equal(limits.rpmLimit, 30);
  assert.equal(limits.dailyTokensLimit, 5000);
  assert.equal(limits.monthlyAmountUsd, 12);
  const extra = (namespace: string) =>
    (db.prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?").get(namespace, "key-admin") as { value: string } | undefined)?.value;
  assert.deepEqual(JSON.parse(String(extra("api_key_tags"))), ["team-a"]);
  assert.equal(extra("api_key_id_format"), "flat");

  const combo = db.prepare("SELECT data FROM combos WHERE id = ?").get("combo-1") as { data: string };
  assert.equal(JSON.parse(combo.data).name, "fast");
  const setting = (key: string) =>
    (db.prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?").get(key) as { value: string } | undefined)?.value;
  assert.equal(JSON.parse(String(setting("password"))), HASH);
  assert.equal(setting("tunnelEnabled"), undefined, "unmapped settings are reported, not copied");

  const usage = db.prepare("SELECT * FROM usage_history ORDER BY timestamp").all() as Record<string, unknown>[];
  assert.equal(usage.length, 2);
  assert.equal(usage[0].api_key_id, "key-admin", "the raw key is joined to its imported id");
  assert.equal(usage[0].tokens_input, 10);
  assert.equal(usage[0].tokens_cache_read, 3);
  assert.equal(usage[0].success, 1);
  assert.equal(usage[1].api_key_id, null);
  assert.equal(usage[1].success, 0);

  // Custom chat models land under the provider the alias resolves to; other kinds are reported.
  const custom = JSON.parse(
    (db.prepare("SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?").get("opencode-go") as { value: string }).value
  );
  assert.deepEqual(custom.map((model: { id: string; name: string }) => [model.id, model.name]), [
    ["deepseek-v4.1-flash", "DS Flash"],
  ]);
  assert.equal(report.imported.customModels, 1);
  assert.equal(report.notMapped["customModels.tts"], 1);
  assert.equal(report.notMapped["kv.customModels"], undefined);

  // Friday's per-user scoping is staged, not lost, and no secret is written next to it.
  const staged = (key: string) =>
    JSON.parse(
      (db.prepare("SELECT value FROM key_value WHERE namespace = 'friday_legacy' AND key = ?").get(key) as { value: string }).value
    );
  assert.deepEqual(staged("owners"), {
    providerConnections: { "conn-oauth": "alice@example.test" },
    apiKeys: { "key-admin": "bob@example.test" },
    combos: { "combo-1": "alice@example.test" },
  });
  const legacySettings = staged("settings");
  assert.equal(legacySettings.scopeResourcesByUser, true);
  assert.deepEqual(legacySettings.ssoAdminEmails, ["alice@example.test"]);
  assert.equal(legacySettings.oidcIssuer, "https://idp.example.test");
  assert.equal("oidcClientSecret" in legacySettings, false);
  assert.equal(JSON.stringify(legacySettings).includes("super-secret-value"), false);
  assert.deepEqual(staged("preferences"), { disabledSharedAccounts: { "bob@example.test": ["conn-key"] } });
  assert.equal(report.notMapped["settings.oidcClientSecret (secret, not staged)"], 1);
  assert.equal(report.notMapped["settings.scopeResourcesByUser"], undefined);
  assert.equal(report.notMapped["kv.disabledSharedAccounts"], undefined);
  assert.ok(report.imported.legacyStaged >= 6);
  // The admin key is imported with the management scope; the report says so.
  assert.match(report.warnings.join(" "), /management scope/);

  // Nothing is dropped silently, and transient per-model locks are not carried over.
  assert.equal(report.notMapped["providerConnections.data.unknownFridayField"], 1);
  assert.equal(report.notMapped["settings.tunnelEnabled"], 1);
  assert.equal(report.notMapped["kv.disabledModels"], 1);
  assert.equal(Object.keys(report.notMapped).some((name) => name.includes("modelLock")), false);

  // Proxy pools become registry proxies and each bound connection gets an account-scope assignment.
  const proxies = db.prepare("SELECT * FROM proxy_registry ORDER BY name").all() as Record<string, unknown>[];
  assert.equal(proxies.length, 2);
  const corp = proxies.find((proxy) => proxy.name === "Corp proxy");
  assert.ok(corp);
  assert.deepEqual(
    [corp.type, corp.host, corp.port, corp.username, corp.password, corp.status],
    ["http", "proxy.example.test", 3128, "alice", "p@ss", "active"]
  );
  assert.match(String(corp.notes), /localhost,\.internal/);
  const relay = proxies.find((proxy) => proxy.name === "Edge relay");
  assert.ok(relay);
  assert.deepEqual(
    [relay.type, relay.host, relay.port, relay.source, relay.status],
    ["vercel", "relay.example.test", 443, "vercel-relay", "active"]
  );
  const assignmentOf = (connection: string) =>
    (db.prepare("SELECT proxy_id FROM proxy_assignments WHERE scope = 'account' AND scope_id = ?").get(connection) as { proxy_id: string } | undefined)?.proxy_id;
  assert.equal(assignmentOf("conn-key"), corp.id);
  assert.equal(assignmentOf("conn-oauth"), relay.id);
  assert.equal(report.imported.proxies, 2);
  assert.equal(report.imported.proxyAssignments, 2);
  // The Friday pool id is gone from the connection: the assignment replaced it.
  assert.equal("proxyPoolId" in JSON.parse(String(apikey.provider_specific_data)), false);
  // Counts are truthful: whole-table counting is replaced by what is really left over.
  assert.equal(report.notMapped.proxyPools, undefined);
  assert.equal(report.notMapped["proxyPools.noProxy (bypass list is not enforced)"], 1);
  assert.equal(report.notMapped["proxyPools.strictProxy"], 1);
  assert.equal(Object.keys(report.notMapped).some((name) => name.includes("proxyPoolId")), false);
  assert.match(report.warnings.join(" "), /relay pool\(s\).*without relay authentication/);
  // Credentials never reach the report, on disk or in memory.
  const reportText = JSON.stringify(report) + readFileSync(join(dataDir, FRIDAY_IMPORT_REPORT), "utf8");
  assert.equal(/alice:|p%40ss|p@ss/.test(reportText), false);

  // The original is untouched; a verified copy and a marker exist.
  assert.equal(sha256(sourceFile), before);
  assert.equal(fridayImportPending(dataDir), false);
  assert.ok(report.backup && sha256(join(report.backup, "data.sqlite")) === before);
});

test("a completed import is not repeated unless forced, and forcing never duplicates usage", async () => {
  await assert.rejects(importFridayData({ dataDir }), /already imported/);
  const report = await importFridayData({ dataDir, force: true });
  assert.equal(report.imported.usageHistory, 0);
  const db = getDbInstance();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage_history").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n, 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM key_value WHERE namespace = 'api_key_tags'").get() as { n: number }).n,
    1
  );
  // Forcing again reuses the proxies and keeps the assignments: nothing is duplicated.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proxy_registry").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proxy_assignments").get() as { n: number }).n, 2);
  assert.equal(report.imported.proxies, 2);
  assert.equal(report.imported.proxyAssignments, 0);
});

test("pool mapping: schemes, relays, duplicates, unusable pools and unbound connections", () => {
  const notMapped: Record<string, number> = {};
  const pool = (id: string, data: Record<string, unknown>, isActive = 1) => ({
    id, isActive, data: JSON.stringify(data),
  });
  const mapping = mapFridayProxyPools(
    [
      pool("socks", { name: "S", proxyUrl: "socks5h://u:pw@10.0.0.1:1080" }),
      pool("bare", { proxyUrl: "10.0.0.2:8080" }, 0),
      pool("dup", { name: "dup", proxyUrl: "http://10.0.0.2:8080" }),
      pool("cf", { name: "CF", type: "cloudflare", proxyUrl: "https://w.example.workers.dev" }),
      pool("deno", { name: "D", type: "deno", proxyUrl: "https://d.example.deno.dev:8443" }),
      pool("v4", { proxyUrl: "socks4://10.0.0.3:1080" }),
      pool("empty", { proxyUrl: "" }),
      pool("odd", { type: "weird", proxyUrl: "https://10.0.0.4", extra: 1 }),
    ],
    notMapped
  );
  const byId = (id: string) => mapping.proxies.find((proxy) => proxy.poolIds.includes(id))?.payload;
  assert.deepEqual([byId("socks")?.type, byId("socks")?.port, byId("socks")?.username], ["socks5", 1080, "u"]);
  assert.deepEqual([byId("bare")?.type, byId("bare")?.port, byId("bare")?.status, byId("bare")?.name], ["http", 8080, "inactive", "10.0.0.2:8080"]);
  assert.equal(mapping.keyByPoolId.get("dup"), mapping.keyByPoolId.get("bare"), "same host/port/user collapses");
  assert.deepEqual([byId("cf")?.type, byId("cf")?.port, byId("cf")?.source], ["cloudflare", 443, "cloudflare-relay"]);
  assert.deepEqual([byId("deno")?.type, byId("deno")?.port, byId("deno")?.source], ["deno", 8443, "deno-relay"]);
  assert.deepEqual([byId("odd")?.type, byId("odd")?.port], ["https", 443]);
  assert.equal(mapping.keyByPoolId.has("v4"), false);
  assert.equal(mapping.keyByPoolId.has("empty"), false);
  assert.equal(mapping.proxies.length, 5);
  assert.equal(notMapped["proxyPools.mergedDuplicate"], 1);
  assert.equal(notMapped["proxyPools.unmappable (unsupported scheme socks4)"], 1);
  assert.equal(notMapped["proxyPools.unmappable (no usable proxyUrl)"], 1);
  assert.equal(notMapped["proxyPools.unknownType (imported as http)"], 1);
  assert.equal(notMapped["proxyPools.data.extra"], 1);
  // Credentials are never part of a report key.
  assert.equal(Object.keys(notMapped).some((name) => name.includes("pw")), false);

  const connection = (id: string, poolId?: unknown) => ({
    id,
    data: JSON.stringify({ providerSpecificData: poolId === undefined ? {} : { proxyPoolId: poolId } }),
  });
  assert.deepEqual(
    collectFridayProxyBindings([
      connection("a", "socks"),
      connection("b", "__none__"),
      connection("c", ""),
      connection("d"),
      connection("e", 7),
    ]),
    [{ connectionId: "a", poolId: "socks" }]
  );
});
