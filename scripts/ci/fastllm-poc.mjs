// CI-only experiment: a synthetic Red Router SQLite snapshot adapter, one
// FastLLM process and one current red-routerd process. No product DB or keys.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const fastBinary = process.env.FASTLLM_BINARY;
const redBinary = process.env.RED_ROUTER_BINARY;
assert.ok(fastBinary && redBinary, "CI must provide both binary paths");
// Apply the narrow Red Router patch to the pinned, ephemeral upstream source.
// Rebuild on the hosted runner; never patch or compile the user's checkout.
const upstreamSource = join(process.env.RUNNER_TEMP, "fastllm");
const unpatchedFastBinary = join(process.env.RUNNER_TEMP, "fastllm-unpatched-fixture");
copyFileSync(fastBinary, unpatchedFastBinary);
chmodSync(unpatchedFastBinary, 0o755);
const memoryPatch = fileURLToPath(new URL("../patches/fastllm-memory-only.patch", import.meta.url));
for (const args of [["apply", "--check", memoryPatch], ["apply", memoryPatch]]) {
  const result = spawnSync("git", args, { cwd: upstreamSource, encoding: "utf8" });
  assert.equal(result.status, 0, `cannot apply pinned FastLLM patch: ${result.stderr}`);
}
const rebuild = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: upstreamSource, stdio: "inherit", timeout: 900_000 });
assert.equal(rebuild.status, 0, "patched FastLLM build failed");
const temp = mkdtempSync(join(tmpdir(), "redrouter-fastllm-poc-"));
const fixtureKey = "fixture-red-router-client-key-12345";
const fixtureProviderKey = "fixture-upstream-key-12345";
const internalKey = "fixture-internal-fastllm-key-1234567890";
const controlToken = "fixture-control-token-12345";
const agentPrompt = "agent-context ".repeat(2500);
const principalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const keyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const internalKeyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fixtureDbPath = join(temp, "dashboard-fixture.sqlite");
const db = new DatabaseSync(fixtureDbPath);
for (const migration of ["001_initial_schema.sql", "005_combo_agent_fields.sql", "211_combos_tenant.sql"]) {
  db.exec(readFileSync(new URL(`../../src/lib/db/migrations/${migration}`, import.meta.url), "utf8"));
}
// These columns are installed by the product's apiKeyColumnFallbacks.ts.
db.exec(`ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
  ALTER TABLE api_keys ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE api_keys ADD COLUMN allowed_models TEXT;
  ALTER TABLE api_keys ADD COLUMN is_banned INTEGER DEFAULT 0;
  ALTER TABLE api_keys ADD COLUMN revoked_at TEXT;
  ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
  ALTER TABLE api_keys ADD COLUMN max_requests_per_day INTEGER;
  ALTER TABLE api_keys ADD COLUMN max_requests_per_minute INTEGER;
  ALTER TABLE api_keys ADD COLUMN throttle_delay_ms INTEGER;
  ALTER TABLE api_keys ADD COLUMN max_sessions INTEGER DEFAULT 0;
  ALTER TABLE api_keys ADD COLUMN usage_limit_enabled INTEGER DEFAULT 0;
  ALTER TABLE api_keys ADD COLUMN disable_non_public_models INTEGER DEFAULT 0;
  ALTER TABLE api_keys ADD COLUMN auto_resolve INTEGER DEFAULT 0;
  ALTER TABLE api_keys ADD COLUMN access_schedule TEXT;
  ALTER TABLE api_keys ADD COLUMN proxy_id TEXT;
  ALTER TABLE api_keys ADD COLUMN tenant_id TEXT DEFAULT 'red';
  ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT;
  ALTER TABLE api_keys ADD COLUMN scopes TEXT;
  ALTER TABLE api_keys ADD COLUMN rate_limits TEXT;
  ALTER TABLE api_keys ADD COLUMN allowed_quotas TEXT;
  ALTER TABLE api_keys ADD COLUMN allowed_connections TEXT;
  ALTER TABLE api_keys ADD COLUMN allowed_combos TEXT;
  ALTER TABLE api_keys ADD COLUMN blocked_models TEXT;
  ALTER TABLE api_keys ADD COLUMN allowed_endpoints TEXT;
  ALTER TABLE api_keys ADD COLUMN model_access_mode TEXT DEFAULT 'all';
  ALTER TABLE provider_connections ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'red';
  ALTER TABLE provider_connections ADD COLUMN per_key_proxy_enabled INTEGER DEFAULT 0;
  ALTER TABLE provider_connections ADD COLUMN max_concurrent INTEGER;
  ALTER TABLE provider_connections ADD COLUMN rate_limit_overrides_json TEXT;
  CREATE TABLE api_key_token_limits (api_key_id TEXT, enabled INTEGER);
  CREATE TABLE api_key_quota_limits (api_key_id TEXT, rpm_limit INTEGER, tpm_limit INTEGER, monthly_amount_usd REAL);
  CREATE TABLE api_key_quota_counters (api_key_id TEXT, dimension_key TEXT, bucket_index INTEGER, consumed REAL, updated_at INTEGER, PRIMARY KEY(api_key_id,dimension_key,bucket_index));
  CREATE TABLE api_key_daily_token_limits (api_key_id TEXT);
  CREATE TABLE key_group_members (key_id TEXT);
  CREATE TABLE budget_assignments (budget_id TEXT);
  CREATE TABLE model_combo_mappings (enabled INTEGER);
  CREATE TABLE provider_quota_state (connection_id TEXT);
  CREATE TABLE poc_usage (event_json TEXT);
  PRAGMA journal_mode=WAL;`);
db.prepare("INSERT INTO api_keys (id, name, key, created_at, key_hash, is_active, allowed_models) VALUES (?, 'fixture', ?, '2026-01-01T00:00:00Z', ?, 1, ?)")
  .run(keyId, fixtureKey, digest(fixtureKey), JSON.stringify(["openrouter/vendor/model-a", "openrouter/vendor/model-b", "openai/vendor/model-b"]));
db.prepare("INSERT INTO provider_connections (id, provider, auth_type, api_key, is_active, created_at, updated_at) VALUES ('fixture-connection', 'openrouter', 'apikey', ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(fixtureProviderKey);
db.prepare("INSERT INTO provider_connections (id, provider, auth_type, api_key, is_active, created_at, updated_at) VALUES ('fixture-openai', 'openai', 'apikey', ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(fixtureProviderKey);
db.prepare("INSERT INTO combos (id, name, data, tenant_id, context_cache_protection, created_at, updated_at) VALUES ('fixture-combo', 'bench', ?, 'red', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
  .run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a"] }));

let active = 0;
let peakActive = 0;
let lastUpstreamModel;
let failModelA = false;
let modelAttempts = [];
let snapshotVersion = 1;
let usageEvents = [];
let credentialFixture;
const children = [];
const servers = [];
const serverListen = async (server) => {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
};
const unusedPort = async () => {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const upstream = createServer(async (req, res) => {
  if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(req.url)) {
    res.writeHead(404).end(); return;
  }
  if (req.headers.authorization !== `Bearer ${fixtureProviderKey}`) { res.writeHead(401).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch { res.writeHead(400).end(); return; }
  lastUpstreamModel = body.model;
  modelAttempts.push(body.model);
  if (failModelA && body.model === "vendor/model-a") {
    res.writeHead(429, { "content-type": "application/json" }).end('{"error":"fixture rate limit"}');
    return;
  }
  active++;
  peakActive = Math.max(peakActive, active);
  let finished = false;
  const finish = () => { if (!finished) { finished = true; active--; } };
  res.once("close", finish);
  if (req.url === "/v1/responses") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fixture-response", object: "response", model: body.model, output: [], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } }));
    return;
  }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  await delay(15);
  if (res.destroyed) { finish(); return; }
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
  await delay(10);
  if (res.destroyed) { finish(); return; }
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});

const routePlan = () => spawnSync(redBinary, ["fastllm-route-plan", "bench"], {
  env: { ...process.env, RED_ROUTER_PRODUCT_DB_PATH: fixtureDbPath }, encoding: "utf8", timeout: 10_000,
});

const readSnapshot = (upstreamPort) => {
  const key = db.prepare("SELECT id, key_hash, allowed_models FROM api_keys WHERE is_active = 1").get();
  const connection = db.prepare("SELECT provider, api_key FROM provider_connections WHERE id = 'fixture-connection' AND is_active = 1").get();
  const command = routePlan();
  assert.equal(command.status, 0, `Rust route plan failed: ${command.stderr}`);
  const plan = JSON.parse(command.stdout);
  assert.equal(plan.format, "red-router.fastllm.route-plan.v1");
  assert.equal(plan.provider, connection.provider);
  return {
    version: snapshotVersion,
    open: false,
    keys: { [key.key_hash]: { principal: principalId, expires_at: null, disabled: false, id: key.id },
      [digest(internalKey)]: { principal: principalId, expires_at: null, disabled: false, id: internalKeyId } },
    principals: [{ id: principalId, name: "fixture", allowed_models: ["bench", "vendor/model-a", "vendor/model-b"], allow_all: false }],
    models: [...new Set([plan.frontend_model, plan.upstream_model, "vendor/model-b"])].map((name) => ({ name, backends: [{ api_base: `http://127.0.0.1:${upstreamPort}/v1`, upstream_model: name === "vendor/model-b" ? "vendor/model-b" : plan.upstream_model, api_key: connection.api_key, protocol: "openai" }] })),
  };
};

const waitReady = async (url, child) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null) throw new Error(`gateway exited before ready: ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`gateway did not become ready: ${url}`);
};
const childProcess = (binary, args, env) => {
  const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  child.once("error", (error) => { child.spawnError = error; });
  child.stderr.on("data", (chunk) => { if (process.env.FASTLLM_POC_DEBUG === "1") process.stderr.write(chunk); });
  children.push(child);
  return child;
};
const rssKb = (child) => {
  try { return Number(readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0); } catch { return 0; }
};
const request = async (url, key, model, signal) => fetch(url, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages: [{ role: "user", content: agentPrompt }], stream: true, stream_options: { include_usage: true } }), signal,
});
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
const measure = async (label, url, key, model, concurrency, total, child) => {
  let next = 0;
  peakActive = active;
  const first = [], end = [];
  const start = performance.now();
  let peakRss = child ? rssKb(child) : 0;
  const monitor = setInterval(() => { if (child) peakRss = Math.max(peakRss, rssKb(child)); }, 25);
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++;
        const started = performance.now();
        const response = await request(url, key, model, AbortSignal.timeout(15_000));
        if (response.status !== 200) throw new Error(`${label} returned ${response.status}: ${await response.text()}`);
        const reader = response.body.getReader();
        let text = "", firstAt = null;
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (firstAt === null) firstAt = performance.now();
          text += decoder.decode(chunk.value, { stream: true });
        }
        assert.ok(firstAt !== null && text.includes("[DONE]"), `${label} must finish the stream`);
        first.push(firstAt - started);
        end.push(performance.now() - started);
      }
    }));
  } finally { clearInterval(monitor); }
  first.sort((a, b) => a - b); end.sort((a, b) => a - b);
  return { label, concurrency, requests: total, ttft_p50_ms: percentile(first, 0.5), ttft_p95_ms: percentile(first, 0.95), total_p95_ms: percentile(end, 0.95), throughput_rps: total / ((performance.now() - start) / 1000), upstream_peak_inflight: peakActive, process_peak_rss_kib: peakRss };
};

try {
  const upstreamPort = await serverListen(upstream);
  const control = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${controlToken}`) { res.writeHead(401).end(); return; }
    if (req.method === "GET" && req.url === "/snapshot") {
      if (req.headers["if-none-match"] === `"${snapshotVersion}"`) { res.writeHead(304).end(); return; }
      try {
        const snapshot = readSnapshot(upstreamPort);
        res.writeHead(200, { "content-type": "application/json", etag: `"${snapshotVersion}"` });
        res.end(JSON.stringify(snapshot));
      } catch { res.writeHead(503).end(); }
      return;
    }
    if (req.method === "POST" && req.url === "/usage") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const batch = JSON.parse(Buffer.concat(chunks));
      if (!Array.isArray(batch.events)) { res.writeHead(400).end(); return; }
      usageEvents.push(...batch.events); res.writeHead(200, { "content-type": "application/json" }).end("{}"); return;
    }
    if (req.method === "POST") { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    res.writeHead(404).end();
  });
  const controlPort = await serverListen(control);
  const fastPort = await unusedPort();
  const redPort = await unusedPort();
  const fast = childProcess(fastBinary, ["--host", "127.0.0.1", "--port", String(fastPort), "--role", "proxy", "--control-url", `http://127.0.0.1:${controlPort}/snapshot`, "--proxy-token", controlToken, "--snapshot-cache", join(temp, "fake-snapshot.json"), "--config-poll", "1", "--rate-limit-reconcile-interval", "0", "--shutdown-delay", "0", "--log", "warn"], {});
  const red = childProcess(redBinary, [], { RED_ROUTER_LISTEN: `127.0.0.1:${redPort}`, RED_ROUTER_DB_BACKEND: "sqlite", RED_ROUTER_DATABASE_URL: `sqlite://${join(temp, "red-proxy.sqlite")}?mode=rwc`, RED_ROUTER_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, RED_ROUTER_CLIENT_KEY: fixtureKey, RED_ROUTER_PROVIDER_KEY: fixtureProviderKey });
  await Promise.all([waitReady(`http://127.0.0.1:${fastPort}/health`, fast), waitReady(`http://127.0.0.1:${redPort}/healthz`, red)]);
  const fastUrl = `http://127.0.0.1:${fastPort}/v1/chat/completions`;
  const redUrl = `http://127.0.0.1:${redPort}/v1/chat/completions`;
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
  const rejected = await request(fastUrl, "incorrect-client-key-12345", "bench", AbortSignal.timeout(5000));
  assert.ok([401, 403].includes(rejected.status), `FastLLM accepted unknown key: ${rejected.status}`);
  await rejected.body?.cancel();
  const warm = await request(fastUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
  if (warm.status !== 200) throw new Error(`FastLLM snapshot adapter returned ${warm.status}: ${await warm.text()}`);
  assert.ok((await warm.text()).includes("[DONE]"));
  assert.equal(lastUpstreamModel, "vendor/model-a");
  // Managed mode creates separate random tokens, starts the in-memory source
  // and waits for the expected snapshot before exposing the dashboard proxy.
  const supervisedPort = await unusedPort();
  const supervisedEnv = {
    RED_ROUTER_LISTEN: `127.0.0.1:${supervisedPort}`, RED_ROUTER_PRODUCT_DB_PATH: fixtureDbPath,
    RED_ROUTER_PRODUCT_COMBO: "bench", RED_ROUTER_PRODUCT_CLIENT_KEYS: "1",
  };
  const unpatched = spawnSync(redBinary, [], { env: { ...process.env, ...supervisedEnv, RED_ROUTER_FASTLLM_MANAGED_BINARY: unpatchedFastBinary }, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(unpatched.status, 0, "the unpatched FastLLM must not be accepted");
  assert.match(unpatched.stderr, /FastLLM exited before readiness/);
  process.stderr.write("CI: unpatched engine rejected\n");
  const supervised = childProcess(redBinary, [], { ...supervisedEnv, RED_ROUTER_FASTLLM_MANAGED_BINARY: fastBinary });
  await waitReady(`http://127.0.0.1:${supervisedPort}/healthz`, supervised);
  process.stderr.write("CI: supervised engine ready\n");
  const engineChildren = () => {
    const result = spawnSync("ps", ["-o", "pid=", "--ppid", String(supervised.pid)], { encoding: "utf8" });
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  };
  const firstEngine = engineChildren()[0];
  assert.ok(firstEngine, "supervisor did not start a FastLLM child");
  process.kill(firstEngine, "SIGKILL");
  process.stderr.write("CI: simulated engine exit\n");
  let restarted = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (supervised.exitCode !== null) throw new Error(`supervisor exited: ${supervised.exitCode}`);
    await delay(100);
    const current = engineChildren()[0];
    if (current && current !== firstEngine) {
      try {
        const argv = readFileSync(`/proc/${current}/cmdline`, "utf8").split("\0");
        const enginePort = argv[argv.indexOf("--port") + 1];
        const engineReady = await fetch(`http://127.0.0.1:${enginePort}/health`, { signal: AbortSignal.timeout(500) });
        if (engineReady.ok) {
          // Let the supervisor finish its authenticated version and SQLite
          // checks before intentionally changing the fixture configuration.
          await delay(500);
          if ((await fetch(`http://127.0.0.1:${supervisedPort}/healthz`, { signal: AbortSignal.timeout(500) })).ok) { restarted = true; break; }
        }
      } catch { /* restarting */ }
    }
  }
  assert.ok(restarted, "FastLLM was not restarted by the supervisor");
  process.stderr.write("CI: supervised engine restarted\n");
  db.prepare("UPDATE provider_connections SET is_active = 0 WHERE id = 'fixture-connection'").run();
  let stoppedConfig;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (supervised.exitCode !== null) throw new Error(`supervisor exited before configuration check: ${supervised.exitCode}`);
    try {
      stoppedConfig = await request(`http://127.0.0.1:${supervisedPort}/v1/chat/completions`, fixtureKey, "bench", AbortSignal.timeout(5000));
      break;
    } catch (error) {
      if (attempt === 99) throw new Error("supervisor unavailable after engine restart", { cause: error });
      await delay(250);
    }
  }
  assert.ok([401, 503].includes(stoppedConfig.status), `changed configuration was not rejected: ${stoppedConfig.status}`);
  await stoppedConfig.body?.cancel();
  process.stderr.write("CI: stale dashboard configuration rejected\n");
  db.prepare("UPDATE provider_connections SET is_active = 1 WHERE id = 'fixture-connection'").run();
  // Load a real encrypted product-format credential through the Rust control
  // source, then prove the patched FastLLM loads it without creating a cache.
  const credentialDbPath = join(temp, "credential-fixture.sqlite");
  db.exec(`VACUUM INTO '${credentialDbPath.replaceAll("'", "''")}'`);
  credentialFixture = new DatabaseSync(credentialDbPath);
  credentialFixture.prepare("UPDATE provider_connections SET api_key = ? WHERE id = 'fixture-connection'")
    .run("enc:v1:07070707070707070707070707070707:c08df6423606efea3e7c0312a4ec91a5e0a8d368:d4c8fcd1abdb884abc46108ca32ae870");
  const secureControlToken = "fixture-distinct-control-token-1234567890";
  const credentialControlPort = await unusedPort();
  const credentialControl = childProcess(redBinary, ["fastllm-control"], {
    RED_ROUTER_PRODUCT_DB_PATH: credentialDbPath, RED_ROUTER_PRODUCT_COMBO: "bench",
    RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey, RED_ROUTER_FASTLLM_CONTROL_TOKEN: secureControlToken,
    RED_ROUTER_FASTLLM_CONTROL_LISTEN: `127.0.0.1:${credentialControlPort}`,
    STORAGE_ENCRYPTION_KEY: "fixture-password",
  });
  const credentialUrl = `http://127.0.0.1:${credentialControlPort}/snapshot`;
  let controlReady = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (credentialControl.exitCode !== null) throw new Error(`credential control exited: ${credentialControl.exitCode}`);
    try { if ((await fetch(credentialUrl, { signal: AbortSignal.timeout(500) })).status === 401) { controlReady = true; break; } } catch { /* starting */ }
    await delay(100);
  }
  assert.ok(controlReady, "credential control did not start");
  const controlAuth = { authorization: `Bearer ${secureControlToken}` };
  assert.equal((await fetch(credentialUrl, { headers: controlAuth })).status, 403);
  const protectedSnapshot = await fetch(credentialUrl, { headers: { ...controlAuth, "x-redrouter-memory-only": "1" } });
  assert.equal(protectedSnapshot.status, 200);
  assert.equal(protectedSnapshot.headers.get("cache-control"), "no-store");
  const firstEtag = protectedSnapshot.headers.get("etag");
  assert.ok(firstEtag);
  const protectedConfig = await protectedSnapshot.json();
  assert.equal(protectedConfig.models[0].backends[0].api_key, "fixture-provider-key");
  assert.equal(protectedConfig.models[0].backends[0].api_base, "https://openrouter.ai/api/v1");
  assert.ok(protectedConfig.keys[digest(internalKey)]);
  const managedFastPort = await unusedPort();
  const forbiddenCache = join(temp, "must-not-exist-fastllm-snapshot.json");
  const managedFast = childProcess(fastBinary, ["--host", "127.0.0.1", "--port", String(managedFastPort), "--role", "proxy", "--control-url", credentialUrl, "--snapshot-cache", forbiddenCache, "--redrouter-memory-only", "--config-poll", "1", "--rate-limit-reconcile-interval", "0", "--shutdown-delay", "0", "--log", "warn"], { FASTLLM_PROXY_TOKEN: secureControlToken });
  await waitReady(`http://127.0.0.1:${managedFastPort}/health`, managedFast);
  const managedModels = await fetch(`http://127.0.0.1:${managedFastPort}/v1/models`, { headers: { authorization: `Bearer ${internalKey}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(managedModels.status, 200);
  assert.ok((await managedModels.text()).includes("vendor/model-a"));
  assert.ok(!existsSync(forbiddenCache), "patched FastLLM wrote a credential snapshot");
  assert.ok(!existsSync(join(temp, "must-not-exist-fastllm-snapshot.tmp")), "patched FastLLM wrote a temporary credential snapshot");
  credentialFixture.prepare("UPDATE provider_connections SET is_active = 0 WHERE id = 'fixture-connection'").run();
  const invalidated = await fetch(credentialUrl, { headers: { ...controlAuth, "x-redrouter-memory-only": "1", "if-none-match": firstEtag } });
  assert.equal(invalidated.status, 503);
  credentialFixture.prepare("UPDATE provider_connections SET is_active = 1 WHERE id = 'fixture-connection'").run();
  credentialControl.kill("SIGTERM");
  await new Promise((resolve) => credentialControl.once("exit", resolve));
  credentialFixture.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-b"] }));
  credentialFixture.prepare("UPDATE provider_connections SET api_key = 'rotated-fixture-provider-key' WHERE id = 'fixture-connection'").run();
  const rotatedControl = childProcess(redBinary, ["fastllm-control"], {
    RED_ROUTER_PRODUCT_DB_PATH: credentialDbPath, RED_ROUTER_PRODUCT_COMBO: "bench",
    RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey, RED_ROUTER_FASTLLM_CONTROL_TOKEN: secureControlToken,
    RED_ROUTER_FASTLLM_CONTROL_LISTEN: `127.0.0.1:${credentialControlPort}`, STORAGE_ENCRYPTION_KEY: "fixture-password",
  });
  let rotationLoaded = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (rotatedControl.exitCode !== null) throw new Error(`rotated credential control exited: ${rotatedControl.exitCode}`);
    await delay(250);
    const response = await fetch(`http://127.0.0.1:${managedFastPort}/v1/models`, { headers: { authorization: `Bearer ${internalKey}` }, signal: AbortSignal.timeout(5000) });
    if (response.ok && (await response.text()).includes("vendor/model-b")) { rotationLoaded = true; break; }
  }
  assert.ok(rotationLoaded, "FastLLM did not reload the changed control snapshot");
  assert.ok(!existsSync(forbiddenCache), "FastLLM wrote a snapshot after rotation");
  const rotatedSnapshot = await fetch(credentialUrl, { headers: { ...controlAuth, "x-redrouter-memory-only": "1", "if-none-match": firstEtag } });
  assert.equal(rotatedSnapshot.status, 200);
  assert.notEqual(rotatedSnapshot.headers.get("etag"), firstEtag);
  assert.equal((await rotatedSnapshot.json()).models[0].backends[0].api_key, "rotated-fixture-provider-key");
  for (const provider of ["groq", "mistral", "deepseek", "together", "perplexity"]) {
    credentialFixture.prepare("INSERT INTO provider_connections (id,provider,auth_type,api_key,is_active,created_at,updated_at) VALUES (?,?,'apikey','fixture-provider-key',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(provider, provider);
  }
  credentialFixture.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a", "groq/fixture-groq", "mistral/fixture-mistral", "deepseek/fixture-deepseek", "together/fixture-together", "perplexity/fixture-perplexity"] }));
  const multiControlPort = await unusedPort();
  const multiControl = childProcess(redBinary, ["fastllm-control"], {
    RED_ROUTER_PRODUCT_DB_PATH: credentialDbPath, RED_ROUTER_PRODUCT_COMBO: "bench",
    RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey, RED_ROUTER_FASTLLM_CONTROL_TOKEN: secureControlToken,
    RED_ROUTER_FASTLLM_CONTROL_LISTEN: `127.0.0.1:${multiControlPort}`, STORAGE_ENCRYPTION_KEY: "fixture-password",
  });
  const multiUrl = `http://127.0.0.1:${multiControlPort}/snapshot`;
  let multiResponse;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (multiControl.exitCode !== null) throw new Error(`multi-provider credential control exited: ${multiControl.exitCode}`);
    try {
      multiResponse = await fetch(multiUrl, { headers: { ...controlAuth, "x-redrouter-memory-only": "1", "if-none-match": firstEtag }, signal: AbortSignal.timeout(500) });
      if (multiResponse.status === 200) break;
    } catch { /* starting */ }
    await delay(100);
  }
  assert.equal(multiResponse?.status, 200);
  assert.notEqual(multiResponse.headers.get("etag"), firstEtag);
  const providerModels = (await multiResponse.json()).models;
  assert.deepEqual(providerModels.map((model) => model.backends[0].api_base), [
    "https://openrouter.ai/api/v1", "https://api.groq.com/openai/v1",
    "https://api.mistral.ai/v1", "https://api.deepseek.com", "https://api.together.xyz/v1", "https://api.perplexity.ai",
  ]);
  // The actual Red Router process authenticates the dashboard key and guards
  // the SQLite combo/connection before forwarding to the FastLLM process.
  const bridgePort = await unusedPort();
  const bridge = childProcess(redBinary, [], {
    RED_ROUTER_LISTEN: `127.0.0.1:${bridgePort}`,
    RED_ROUTER_PRODUCT_DB_PATH: fixtureDbPath,
    RED_ROUTER_PRODUCT_COMBO: "bench",
    RED_ROUTER_PRODUCT_CLIENT_KEYS: "1",
    RED_ROUTER_PRODUCT_SHARED_RPM: "1",
    RED_ROUTER_FASTLLM_URL: fastUrl,
    RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey,
  });
  await waitReady(`http://127.0.0.1:${bridgePort}/healthz`, bridge);
  const bridgeUrl = `http://127.0.0.1:${bridgePort}/v1/chat/completions`;
  const deniedBridge = await request(bridgeUrl, "unknown-dashboard-key-12345", "bench", AbortSignal.timeout(5000));
  assert.equal(deniedBridge.status, 401);
  await deniedBridge.body?.cancel();
  peakActive = active;
  const parallel = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await request(bridgeUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
    if (response.status !== 200) throw new Error(`dashboard bridge returned ${response.status}: ${await response.text()}`);
    assert.ok((await response.text()).includes("[DONE]"));
  }));
  void parallel;
  const bridgePeak = peakActive;
  assert.ok(bridgePeak > 1, `dashboard bridge serialized concurrent agents: ${bridgePeak}`);
  assert.equal(lastUpstreamModel, "vendor/model-a");
  db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(keyId);
  const revoked = await request(bridgeUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
  assert.equal(revoked.status, 401);
  await revoked.body?.cancel();
  db.prepare("UPDATE api_keys SET is_active = 1 WHERE id = ?").run(keyId);
  db.prepare("INSERT INTO api_key_quota_limits (api_key_id,rpm_limit) VALUES (?,1)").run(keyId);
  const limited = await request(bridgeUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
  assert.equal(limited.status, 429);
  await limited.body?.cancel();
  db.prepare("DELETE FROM api_key_quota_limits WHERE api_key_id = ?").run(keyId);
  // Token/spend enforcement is deliberately not enabled until reservations
  // are wired through every writer. Reject this key without blocking others.
  db.prepare("INSERT INTO api_key_quota_limits (api_key_id,tpm_limit,monthly_amount_usd) VALUES (?,100,1)").run(keyId);
  const unimplementedQuota = await request(bridgeUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
  assert.equal(unimplementedQuota.status, 503);
  await unimplementedQuota.body?.cancel();
  const independentKey = "fixture-independent-dashboard-key-98765";
  db.prepare("INSERT INTO api_keys (id,name,key,created_at,key_hash,is_active,allowed_models) VALUES ('independent','fixture-2',?,'2026-01-01T00:00:00Z',?,1,?)")
    .run(independentKey, digest(independentKey), JSON.stringify(["openrouter/vendor/model-a"]));
  const independent = await request(bridgeUrl, independentKey, "bench", AbortSignal.timeout(5000));
  if (independent.status !== 200) throw new Error(`independent key returned ${independent.status}: ${await independent.text()}`);
  assert.ok((await independent.text()).includes("[DONE]"));
  db.prepare("DELETE FROM api_keys WHERE id = 'independent'").run();
  db.prepare("DELETE FROM api_key_quota_limits WHERE api_key_id = ?").run(keyId);
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a", "openai/vendor/model-b"] }));
  const fallbackPort = await unusedPort();
  const fallbackBridge = childProcess(redBinary, [], {
    RED_ROUTER_LISTEN: `127.0.0.1:${fallbackPort}`,
    RED_ROUTER_PRODUCT_DB_PATH: fixtureDbPath,
    RED_ROUTER_PRODUCT_COMBO: "bench",
    RED_ROUTER_PRODUCT_CLIENT_KEYS: "1",
    RED_ROUTER_PRODUCT_SHARED_RPM: "1",
    RED_ROUTER_FASTLLM_URL: fastUrl,
    RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey,
  });
  await waitReady(`http://127.0.0.1:${fallbackPort}/healthz`, fallbackBridge);
  failModelA = true;
  modelAttempts = [];
  const fallbackResponse = await request(`http://127.0.0.1:${fallbackPort}/v1/chat/completions`, fixtureKey, "bench", AbortSignal.timeout(5000));
  if (fallbackResponse.status !== 200) throw new Error(`dashboard fallback returned ${fallbackResponse.status}: ${await fallbackResponse.text()}`);
  assert.ok((await fallbackResponse.text()).includes("[DONE]"));
  assert.deepEqual(modelAttempts, ["vendor/model-a", "vendor/model-b"]);
  failModelA = false;
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a"] }));
  const staleCombo = await request(`http://127.0.0.1:${fallbackPort}/v1/chat/completions`, fixtureKey, "bench", AbortSignal.timeout(5000));
  assert.equal(staleCombo.status, 503);
  await staleCombo.body?.cancel();
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a", "openai/vendor/model-a"] }));
  const duplicateAlias = spawnSync(redBinary, [], { env: { ...process.env,
    RED_ROUTER_LISTEN: `127.0.0.1:${fallbackPort}`, RED_ROUTER_PRODUCT_DB_PATH: fixtureDbPath,
    RED_ROUTER_PRODUCT_COMBO: "bench", RED_ROUTER_PRODUCT_CLIENT_KEYS: "1",
    RED_ROUTER_FASTLLM_URL: fastUrl, RED_ROUTER_FASTLLM_INTERNAL_KEY: internalKey,
  }, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(duplicateAlias.status, 0);
  assert.match(duplicateAlias.stderr, /unique upstream model names/);
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a"] }));
  const responsesProbe = await fetch(`http://127.0.0.1:${fastPort}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureKey}` },
    body: JSON.stringify({ model: "bench", input: "hello", stream: false }), signal: AbortSignal.timeout(5000),
  });
  const responsesBody = await responsesProbe.text();
  const messagesProbe = await fetch(`http://127.0.0.1:${fastPort}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": fixtureKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "bench", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream: true }), signal: AbortSignal.timeout(5000),
  });
  const messagesBody = await messagesProbe.text();
  const protocolProbes = {
    responses: { status: responsesProbe.status, has_response_object: responsesBody.includes('"response"') },
    anthropic_messages_stream: { status: messagesProbe.status, has_message_events: messagesBody.includes("message_start") && messagesBody.includes("message_stop") },
  };
  const measurements = [];
  for (const concurrency of [1, 8, 32, 64]) {
    for (const [label, url, key, model, child] of [
      ["mock-direct", upstreamUrl, fixtureProviderKey, "vendor/model-a", null],
      ["fastllm-sqlite-fixture", fastUrl, fixtureKey, "bench", fast],
      ["current-rust-env-baseline", redUrl, fixtureKey, "vendor/model-a", red],
      ["dashboard-sqlite-through-fastllm", bridgeUrl, fixtureKey, "bench", bridge],
    ]) {
      measurements.push(await measure(label, url, key, model, concurrency, 128, child));
    }
  }
  const fast64 = measurements.find((m) => m.label === "fastllm-sqlite-fixture" && m.concurrency === 64);
  assert.ok(fast64.upstream_peak_inflight > 1, `FastLLM never forwarded concurrent traffic: peak=${fast64.upstream_peak_inflight}`);
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-b"] }));
  snapshotVersion++;
  let reloaded = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    const response = await request(fastUrl, fixtureKey, "bench", AbortSignal.timeout(5000));
    await response.text();
    if (response.status === 200 && lastUpstreamModel === "vendor/model-b") { reloaded = true; break; }
  }
  assert.ok(reloaded, "SQLite fixture update was not reflected in FastLLM snapshot");
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a", "openrouter/vendor/model-b"] }));
  const rejectedPlan = routePlan();
  assert.notEqual(rejectedPlan.status, 0, "multiple targets must not be silently converted to a backend pool");
  assert.ok(!rejectedPlan.stdout.includes(fixtureProviderKey), "route plans must not expose provider credentials");
  db.prepare("UPDATE combos SET data = ? WHERE name = 'bench'").run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-b"] }));
  await delay(6000);
  for (const event of usageEvents) db.prepare("INSERT INTO poc_usage VALUES (?)").run(JSON.stringify(event));
  const reported = db.prepare("SELECT COUNT(*) AS n FROM poc_usage").get().n;
  assert.ok(reported > 0, "FastLLM sent no usage events to the fixture control plane");
  console.log(JSON.stringify({ fixture: "synthetic SQLite; no real dashboard or credentials", fastllm_commit: "07faa4a5068928da49eed5ffbd369d18f8a8243e", request_body_approx_bytes: Buffer.byteLength(agentPrompt), requests_per_case: 128, concurrency: [1, 8, 32, 64], upstream_simulated_first_chunk_ms: 15, upstream_simulated_remaining_ms: 10, fastllm_peak_concurrent_upstreams: fast64.upstream_peak_inflight, dashboard_bridge_peak_concurrent_upstreams: bridgePeak, dashboard_key_rejected: deniedBridge.status, dashboard_key_revoked: revoked.status, dashboard_rpm_limited: limited.status, rejected_key_status: rejected.status, sqlite_fixture_reload: reloaded, fixture_usage_events: reported, protocol_probes: protocolProbes, memory_scope: "gateway process only; excludes Node fixture/control process and dashboard", measurements }, null, 2));
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map(async (child) => { if (child.exitCode !== null) return; await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]); if (child.exitCode === null) child.kill("SIGKILL"); }));
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  credentialFixture?.close();
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
