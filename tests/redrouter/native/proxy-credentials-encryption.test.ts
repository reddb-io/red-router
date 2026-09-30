import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Outbound-proxy registry credentials (username + password) are encrypted at rest and stay
// plaintext for every caller. The storage key is deliberately UNSET while the modules load: the
// first test proves the no-key passthrough, then the key is configured for everything after it
// (the encryption module derives the key lazily and caches it once it is set).
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-proxy-credentials-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-proxy-credentials";
delete process.env.STORAGE_ENCRYPTION_KEY;

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const proxies = await import("../../../src/lib/db/proxies.ts");
const credentials = await import("../../../src/lib/db/proxies/credentials.ts");
const { promoteFreeProxyToPool } = await import("../../../src/lib/db/freeProxies.ts");
const { applyProxyPreset } = await import("../../../src/lib/proxyPresets/apply.ts");
const subscriptions = await import("../../../src/lib/proxySubscription/index.ts");

const USER = "brd-customer-hl_4242abcd-zone-res1-session-s77";
const PASS = "Zone-Secret-Pa55w0rd-never-in-plaintext";
const OTHER_PASS = "Rotated-Secret-0987654321";

type RawRow = {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
  source: string;
  subscription_id: string | null;
};

function rawRows(): RawRow[] {
  return getDbInstance()
    .prepare(
      "SELECT id, host, port, username, password, source, subscription_id FROM proxy_registry ORDER BY rowid"
    )
    .all() as RawRow[];
}

function rawDump(): string {
  return JSON.stringify(getDbInstance().prepare("SELECT * FROM proxy_registry").all());
}

function assertNoPlaintext(...secrets: string[]) {
  const dump = rawDump();
  for (const secret of secrets) {
    assert.equal(dump.includes(secret), false, `plaintext leaked into proxy_registry: ${secret}`);
  }
}

function insertLegacyPlaintextRow(id: string, username: string, password: string, port = 9000) {
  const now = new Date().toISOString();
  getDbInstance()
    .prepare(
      `INSERT INTO proxy_registry
        (id, name, type, host, port, username, password, status, source, family, created_at, updated_at)
       VALUES (?, ?, 'http', 'legacy.example.com', ?, ?, ?, 'active', 'manual', 'auto', ?, ?)`
    )
    .run(id, `legacy-${id}`, port, username, password, now, now);
}

function encryptWithKey(secret: string, plaintext: string): string {
  const key = scryptSync(secret, "omniroute-field-encryption-v1", 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
  return `enc:v1:${iv.toString("hex")}:${body}:${cipher.getAuthTag().toString("hex")}`;
}

function startFeedServer(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no address");
      resolve({
        url: `http://127.0.0.1:${address.port}/feed`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

beforeEach(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(dataDir, { recursive: true });
});

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("without a storage key credentials stay plaintext and maintenance is a no-op", async () => {
  const created = await proxies.createProxy({
    name: "keyless",
    type: "http",
    host: "keyless.example.com",
    port: 8080,
    username: USER,
    password: PASS,
  });
  assert.ok(created?.id);

  const [row] = rawRows();
  assert.equal(row.username, USER);
  assert.equal(row.password, PASS);

  const stored = await proxies.getProxyById(created.id, { includeSecrets: true });
  assert.equal(stored?.username, USER);
  assert.equal(stored?.password, PASS);

  assert.deepEqual(credentials.encryptExistingProxyCredentials(getDbInstance()), { encrypted: 0 });
  assert.equal(rawRows()[0].password, PASS);

  // The key is configured from here on; the rows written above are legacy plaintext to it.
  process.env.STORAGE_ENCRYPTION_KEY = TEST_KEY;
});

test("create and update never store plaintext and reads return plaintext", async () => {
  const created = await proxies.createProxy({
    name: "primary",
    type: "http",
    host: "gateway.example.com",
    port: 22225,
    username: USER,
    password: PASS,
  });
  assert.ok(created?.id);
  assertNoPlaintext(USER, PASS, "zone-res1", "hl_4242abcd");
  assert.match(rawRows()[0].username, /^enc:v1:/);
  assert.match(rawRows()[0].password, /^enc:v1:/);

  const redacted = await proxies.getProxyById(created.id);
  assert.equal(redacted?.username, "***");
  assert.equal(redacted?.password, "***");
  const full = await proxies.getProxyById(created.id, { includeSecrets: true });
  assert.equal(full?.username, USER);
  assert.equal(full?.password, PASS);

  await proxies.updateProxy(created.id, { password: OTHER_PASS });
  assertNoPlaintext(USER, PASS, OTHER_PASS);
  const rotated = await proxies.getProxyById(created.id, { includeSecrets: true });
  assert.equal(rotated?.username, USER);
  assert.equal(rotated?.password, OTHER_PASS);

  // An update that omits credentials keeps the stored ciphertext untouched.
  const before = rawRows()[0];
  await proxies.updateProxy(created.id, { status: "inactive" });
  const after = rawRows()[0];
  assert.equal(after.username, before.username);
  assert.equal(after.password, before.password);
  const listed = await proxies.listProxies({ includeSecrets: true });
  assert.equal(listed.items[0].username, USER);
  assert.equal(listed.items[0].password, OTHER_PASS);

  // Explicitly blank credentials clear the stored auth.
  await proxies.updateProxy(created.id, { username: "", password: "" });
  assert.equal(rawRows()[0].username, "");
  assert.equal(rawRows()[0].password, "");
});

test("registry identity still dedupes on host, port and username", async () => {
  const base = { name: "n", type: "http", host: "gw.example.com", port: 22225 };

  const first = await proxies.upsertProxy({ ...base, username: USER, password: PASS });
  assert.equal(first.action, "created");

  const same = await proxies.upsertProxy({ ...base, username: USER, password: PASS });
  assert.equal(same.action, "updated");
  assert.equal(same.proxy?.id, first.proxy?.id);
  assert.equal(rawRows().length, 1);

  // A password-only rotation updates the same row (#7703).
  const rotated = await proxies.upsertProxy({ ...base, username: USER, password: OTHER_PASS });
  assert.equal(rotated.action, "updated");
  assert.equal(rotated.proxy?.id, first.proxy?.id);
  assert.equal(rawRows().length, 1);
  const stored = await proxies.getProxyById(first.proxy?.id ?? "", { includeSecrets: true });
  assert.equal(stored?.password, OTHER_PASS);

  // A different username on the same host and port is a different identity (#7594).
  const other = await proxies.upsertProxy({ ...base, username: `${USER}-b`, password: PASS });
  assert.equal(other.action, "created");
  assert.notEqual(other.proxy?.id, first.proxy?.id);
  assert.equal(rawRows().length, 2);

  // Credential-less proxies keep matching on the empty username.
  const anon = await proxies.upsertProxy({ ...base, host: "anon.example.com" });
  const anonAgain = await proxies.upsertProxy({ ...base, host: "anon.example.com" });
  assert.equal(anon.action, "created");
  assert.equal(anonAgain.action, "updated");
  assert.equal(anonAgain.proxy?.id, anon.proxy?.id);

  assertNoPlaintext(USER, PASS, OTHER_PASS);
});

test("subscription refresh, presets and free-proxy promotion store no plaintext", async () => {
  // Subscription refresh: nodes are synced through the same upsert path.
  const feed = [
    "proxies:",
    "  - name: sub-node",
    "    type: http",
    "    server: 127.0.0.1",
    "    port: 18301",
    `    username: ${USER}`,
    `    password: ${PASS}`,
  ].join("\n");
  const server = await startFeedServer(feed);
  try {
    const now = new Date().toISOString();
    getDbInstance()
      .prepare(
        `INSERT INTO proxy_subscriptions
          (id, name, url, enabled, mode, rule_providers, update_interval_minutes, status, created_at, updated_at)
         VALUES ('sc1', 'sub-sc1', ?, 1, 'global', NULL, 60, 'empty', ?, ?)`
      )
      .run(server.url, now, now);
    await subscriptions.syncSubscription("sc1");
    await subscriptions.syncSubscription("sc1");
  } finally {
    await server.close();
  }
  const synced = rawRows().filter((row) => row.source === "subscription");
  assert.equal(synced.length, 1, "a re-sync must update the row, not duplicate it");
  const syncedProxy = await proxies.getProxyById(synced[0].id, { includeSecrets: true });
  assert.equal(syncedProxy?.username, USER);
  assert.equal(syncedProxy?.password, PASS);

  // Preset apply (Bright Data composes the username from the customer and zone).
  const applied = await applyProxyPreset({
    presetId: "brightdata",
    name: "BD",
    params: { customer: "hl_customer9876", zone: "res1", password: OTHER_PASS },
  });
  const presetProxy = await proxies.getProxyById(applied.proxy.id, { includeSecrets: true });
  assert.match(presetProxy?.username ?? "", /hl_customer9876/);
  assert.equal(presetProxy?.password, OTHER_PASS);

  // Free-proxy promotion writes credential-less rows.
  const now = new Date().toISOString();
  getDbInstance()
    .prepare(
      `INSERT INTO free_proxies (id, source, host, port, type, in_pool, created_at, updated_at)
       VALUES ('fp1', 'test', 'free.example.com', 3128, 'http', 0, ?, ?)`
    )
    .run(now, now);
  const poolId = await promoteFreeProxyToPool("fp1", {
    name: "free",
    type: "http",
    host: "free.example.com",
    port: 3128,
    source: "free-proxy",
  });
  assert.ok(poolId);
  const promoted = await proxies.getProxyById(poolId ?? "", { includeSecrets: true });
  assert.equal(promoted?.username, "");
  assert.equal(promoted?.password, "");

  assertNoPlaintext(USER, PASS, OTHER_PASS, "hl_customer9876");
});

test("managed WireGuard proxies keep their generated credentials round-tripping", async () => {
  const created = await proxies.createProxy({
    name: "WireGuard: lab",
    type: "socks5",
    host: "127.0.0.1",
    port: 51080,
    username: "wg-user-1",
    password: "wg-pass-1",
    source: "wireguard-egress",
    status: "inactive",
  });
  assert.ok(created?.id);
  await proxies.updateProxy(
    created.id,
    { username: "wg-user-2", password: "wg-pass-2", status: "active" },
    { allowManaged: true }
  );
  assertNoPlaintext("wg-user-1", "wg-pass-1", "wg-user-2", "wg-pass-2");
  const stored = await proxies.getProxyById(created.id, { includeSecrets: true });
  assert.equal(stored?.username, "wg-user-2");
  assert.equal(stored?.password, "wg-pass-2");
  await assert.rejects(() => proxies.updateProxy(created.id, { password: "manual" }), {
    code: "proxy_managed",
  });
});

test("selection and rotation paths resolve plaintext credentials", async () => {
  const created = await proxies.createProxy({
    name: "pooled",
    type: "http",
    host: "pool.example.com",
    port: 3128,
    username: USER,
    password: PASS,
  });
  assert.ok(created?.id);
  await proxies.assignProxyToScope("global", null, created.id);
  await proxies.addProxyToScopePool("provider", "openai", created.id);
  assertNoPlaintext(USER, PASS);

  const global = await proxies.resolveProxyForScopeFromRegistry("global");
  assert.equal(global?.proxy.username, USER);
  assert.equal(global?.proxy.password, PASS);

  const provider = await proxies.resolveProxyForProvider("openai");
  assert.equal(provider?.username, USER);
  assert.equal(provider?.password, PASS);

  const [egressRow] = proxies.getScopePoolEgressRows("provider", "openai");
  assert.equal(egressRow.username, USER);
  assert.equal(egressRow.password, PASS);

  // The pool validator (proxyEgress) reads credentials through listProxies({ includeSecrets }).
  const listed = await proxies.listProxies({ includeSecrets: true });
  assert.equal(listed.items[0].username, USER);
  assert.equal(listed.items[0].password, PASS);
});

test("legacy plaintext rows stay readable and are encrypted exactly once", async () => {
  insertLegacyPlaintextRow("legacy-1", USER, PASS);
  insertLegacyPlaintextRow("legacy-2", "", "", 9001);

  const before = await proxies.getProxyById("legacy-1", { includeSecrets: true });
  assert.equal(before?.username, USER);
  assert.equal(before?.password, PASS);
  assert.equal(rawRows()[0].username, USER, "reading must not rewrite the row");

  let backups = 0;
  const first = credentials.encryptExistingProxyCredentials(getDbInstance(), {
    beforeWrite: () => {
      backups += 1;
    },
  });
  assert.deepEqual(first, { encrypted: 1 });
  assert.equal(backups, 1);
  assertNoPlaintext(USER, PASS);
  const encryptedRow = rawRows()[0];
  assert.match(encryptedRow.username, /^enc:v1:/);
  assert.match(encryptedRow.password, /^enc:v1:/);
  assert.equal(rawRows()[1].username, "");

  const after = await proxies.getProxyById("legacy-1", { includeSecrets: true });
  assert.equal(after?.username, USER);
  assert.equal(after?.password, PASS);

  const second = credentials.encryptExistingProxyCredentials(getDbInstance(), {
    beforeWrite: () => {
      backups += 1;
    },
  });
  assert.deepEqual(second, { encrypted: 0 });
  assert.equal(backups, 1, "an idempotent re-run must not back up again");
  assert.equal(rawRows()[0].username, encryptedRow.username);
  assert.equal(rawRows()[0].password, encryptedRow.password);

  // A legacy plaintext row is also matched by identity and encrypted by the next write.
  insertLegacyPlaintextRow("legacy-3", USER, PASS, 9002);
  const upserted = await proxies.upsertProxy({
    name: "again",
    type: "http",
    host: "legacy.example.com",
    port: 9002,
    username: USER,
    password: OTHER_PASS,
  });
  assert.equal(upserted.action, "updated");
  assert.equal(upserted.proxy?.id, "legacy-3");
  assertNoPlaintext(USER, PASS, OTHER_PASS);
});

test("opening the database encrypts legacy plaintext rows at boot", async () => {
  insertLegacyPlaintextRow("boot-1", USER, PASS, 9200);
  assert.equal(rawRows()[0].password, PASS);

  resetDbInstance();
  getDbInstance();

  assertNoPlaintext(USER, PASS);
  const proxy = await proxies.getProxyById("boot-1", { includeSecrets: true });
  assert.equal(proxy?.username, USER);
  assert.equal(proxy?.password, PASS);
});

test("an undecryptable credential reads as empty with a value-free warning", async () => {
  const wrongUser = encryptWithKey(OTHER_KEY, USER);
  const wrongPass = encryptWithKey(OTHER_KEY, PASS);
  insertLegacyPlaintextRow("stale-1", wrongUser, wrongPass, 9100);

  const warnings = captureWarnings();
  try {
    const proxy = await proxies.getProxyById("stale-1", { includeSecrets: true });
    assert.equal(proxy?.username, "");
    assert.equal(proxy?.password, "");
    await proxies.listProxies({ includeSecrets: true });
    assert.ok(warnings.messages.length >= 1, "expected a warning");
    // Logged once per credential, never with the ciphertext or a plaintext value.
    assert.ok(warnings.messages.length <= 2, "warnings must be deduplicated");
    for (const message of warnings.messages) {
      assert.equal(message.includes(USER), false);
      assert.equal(message.includes(PASS), false);
      assert.equal(message.includes("enc:v1:"), false);
    }
  } finally {
    warnings.restore();
  }

  // Resolution does not throw for the row either.
  await proxies.assignProxyToScope("global", null, "stale-1");
  const resolved = await proxies.resolveProxyForScopeFromRegistry("global");
  assert.equal(resolved?.proxy.username, "");

  // An empty-username identity never matches the undecryptable row: a new row is created.
  const upserted = await proxies.upsertProxy({
    name: "fresh",
    type: "http",
    host: "legacy.example.com",
    port: 9100,
  });
  assert.equal(upserted.action, "created");

  // A write that preserves credentials keeps the original ciphertext for the right key.
  await proxies.updateProxy("stale-1", { status: "inactive" });
  const preserved = rawRows().find((row) => row.id === "stale-1");
  assert.equal(preserved?.username, wrongUser);
  assert.equal(preserved?.password, wrongPass);

  // Maintenance leaves values that are already ciphertext alone.
  assert.deepEqual(credentials.encryptExistingProxyCredentials(getDbInstance()), { encrypted: 0 });
});
