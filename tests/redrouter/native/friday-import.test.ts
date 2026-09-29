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
const { fridayImportPending, importFridayData, FRIDAY_IMPORT_MARKER } =
  await import("../../../src/lib/db/fridayImport.ts");

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
    }),
    now, now, null
  );
  db.prepare("INSERT INTO providerConnections VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "conn-key", "openrouter", "apikey", "OR", null, 2, 1,
    JSON.stringify({ apiKey: "sk-or-fixture", providerSpecificData: { region: "us" } }),
    now, now, null
  );
  db.prepare("INSERT INTO apiKeys VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "key-admin", "sk-admin-fixture-0001", "Admin", "machine1", 1, now,
    JSON.stringify(["conn-key"]), JSON.stringify(["team-a"]), null,
    JSON.stringify({ mode: "allow", patterns: ["claude/*"] }),
    JSON.stringify({ rpm: 30, tokensPerDay: 5000, usdPerMonth: 12 }), "flat", "admin"
  );
  db.prepare("INSERT INTO apiKeys VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "key-off", "sk-off-fixture-0002", "Disabled", "machine1", 0, now,
    null, null, null, null, null, null, null
  );
  db.prepare("INSERT INTO combos VALUES (?,?,?,?,?,?,?)").run(
    "combo-1", "fast", null, JSON.stringify(["claude/claude-opus-5-5", "openrouter/x/y"]), null, now, now
  );
  db.prepare("INSERT INTO settings VALUES (1, ?)").run(
    JSON.stringify({ password: HASH, requireLogin: true, tunnelEnabled: true })
  );
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run("modelAliases", "fast-alias", JSON.stringify("claude/x"));
  db.prepare("INSERT INTO kv VALUES (?,?,?)").run("disabledModels", "claude", JSON.stringify(["a"]));
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

  // Nothing is dropped silently, and transient per-model locks are not carried over.
  assert.equal(report.notMapped["providerConnections.data.unknownFridayField"], 1);
  assert.equal(report.notMapped["settings.tunnelEnabled"], 1);
  assert.equal(report.notMapped["kv.disabledModels"], 1);
  assert.equal(Object.keys(report.notMapped).some((name) => name.includes("modelLock")), false);

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
});
