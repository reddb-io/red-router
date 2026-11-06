// CI-only experiment: a synthetic Red Router SQLite snapshot adapter, one
// FastLLM process and one current red-routerd process. No product DB or keys.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const fastBinary = process.env.FASTLLM_BINARY;
const redBinary = process.env.RED_ROUTER_BINARY;
assert.ok(fastBinary && redBinary, "CI must provide both binary paths");
const temp = mkdtempSync(join(tmpdir(), "redrouter-fastllm-poc-"));
const fixtureKey = "fixture-red-router-client-key-12345";
const fixtureProviderKey = "fixture-upstream-key-12345";
const controlToken = "fixture-control-token-12345";
const principalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const keyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const db = new DatabaseSync(join(temp, "dashboard-fixture.sqlite"));
for (const migration of ["001_initial_schema.sql", "005_combo_agent_fields.sql", "211_combos_tenant.sql"]) {
  db.exec(readFileSync(new URL(`../../src/lib/db/migrations/${migration}`, import.meta.url), "utf8"));
}
// These columns are installed by the product's apiKeyColumnFallbacks.ts.
db.exec(`ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
  ALTER TABLE api_keys ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE api_keys ADD COLUMN allowed_models TEXT;
  CREATE TABLE poc_usage (event_json TEXT);
  PRAGMA journal_mode=WAL;`);
db.prepare("INSERT INTO api_keys (id, name, key, created_at, key_hash, is_active, allowed_models) VALUES (?, 'fixture', ?, '2026-01-01T00:00:00Z', ?, 1, ?)")
  .run(keyId, fixtureKey, digest(fixtureKey), JSON.stringify(["bench"]));
db.prepare("INSERT INTO provider_connections (id, provider, auth_type, api_key, is_active, created_at, updated_at) VALUES ('fixture-connection', 'openrouter', 'apikey', ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(fixtureProviderKey);
db.prepare("INSERT INTO combos (id, name, data, tenant_id, context_cache_protection, created_at, updated_at) VALUES ('fixture-combo', 'bench', ?, 'red', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
  .run(JSON.stringify({ name: "bench", strategy: "priority", models: ["openrouter/vendor/model-a"] }));

let active = 0;
let peakActive = 0;
let snapshotVersion = 1;
let usageEvents = [];
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

const readSnapshot = (upstreamPort) => {
  const key = db.prepare("SELECT id, key_hash, allowed_models FROM api_keys WHERE is_active = 1").get();
  const connection = db.prepare("SELECT provider, api_key FROM provider_connections WHERE id = 'fixture-connection' AND is_active = 1").get();
  const combo = db.prepare("SELECT name, data FROM combos WHERE name = 'bench' AND tenant_id = 'red' AND context_cache_protection = 0").get();
  const config = JSON.parse(combo.data);
  assert.equal(config.strategy, "priority");
  assert.equal(config.models.length, 1, "this fixture adapter only supports a single target");
  const prefix = `${connection.provider}/`;
  assert.ok(config.models[0].startsWith(prefix));
  return {
    version: snapshotVersion,
    open: false,
    keys: { [key.key_hash]: { principal: principalId, expires_at: null, disabled: false, id: key.id } },
    principals: [{ id: principalId, name: "fixture", allowed_models: JSON.parse(key.allowed_models), allow_all: false }],
    models: [{ name: combo.name, backends: [{ api_base: `http://127.0.0.1:${upstreamPort}/v1`, upstream_model: config.models[0].slice(prefix.length), api_key: connection.api_key, protocol: "openai" }] }],
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
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: true, stream_options: { include_usage: true } }), signal,
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
      res.writeHead(200, { "content-type": "application/json", etag: `"${snapshotVersion}"` });
      res.end(JSON.stringify(readSnapshot(upstreamPort))); return;
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
  assert.ok((await warm.text()).includes("vendor/model-a"));
  const measurements = [];
  for (const concurrency of [1, 8, 32, 64]) {
    for (const [label, url, key, model, child] of [
      ["mock-direct", upstreamUrl, fixtureProviderKey, "vendor/model-a", null],
      ["fastllm-sqlite-fixture", fastUrl, fixtureKey, "bench", fast],
      ["current-rust-env-baseline", redUrl, fixtureKey, "vendor/model-a", red],
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
    if (response.status === 200 && (await response.text()).includes("vendor/model-b")) { reloaded = true; break; }
  }
  assert.ok(reloaded, "SQLite fixture update was not reflected in FastLLM snapshot");
  await delay(6000);
  for (const event of usageEvents) db.prepare("INSERT INTO poc_usage VALUES (?)").run(JSON.stringify(event));
  const reported = db.prepare("SELECT COUNT(*) AS n FROM poc_usage").get().n;
  assert.ok(reported > 0, "FastLLM sent no usage events to the fixture control plane");
  console.log(JSON.stringify({ fixture: "synthetic SQLite; no real dashboard or credentials", fastllm_commit: "07faa4a5068928da49eed5ffbd369d18f8a8243e", requests_per_case: 128, concurrency: [1, 8, 32, 64], upstream_simulated_first_chunk_ms: 15, upstream_simulated_remaining_ms: 10, fastllm_peak_concurrent_upstreams: fast64.upstream_peak_inflight, rejected_key_status: rejected.status, sqlite_fixture_reload: reloaded, fixture_usage_events: reported, memory_scope: "gateway process only; excludes Node fixture/control process and dashboard", measurements }, null, 2));
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map(async (child) => { if (child.exitCode !== null) return; await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]); if (child.exitCode === null) child.kill("SIGKILL"); }));
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
