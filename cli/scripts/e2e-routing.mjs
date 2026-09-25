// End-to-end routing check against the shipped server. Every upstream is a local
// fixture (two RedRouter-compatible remotes, one fast and one slow), so it needs
// no credentials and no network. Covers what unit tests cannot: the pieces wired
// together through HTTP.
//   1. a forced reasoning level is reported back;
//   2. combos list members and parameters, and the catalog version moves when a combo changes;
//   3. a failure that arrives with HTTP 200 falls back to the next combo member;
//   4. a client disconnect still records the request (status "aborted");
//   5. the `health` strategy moves traffic to the faster account;
//   6. disabled models and key rules answer 403, key limits 429 with Retry-After.
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const pkg = process.argv[2] || fileURLToPath(new URL("../", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-e2e-routing-"));
const FIXTURE_KEY = "e2e-fixture-key";
const MODELS = ["fx/ok", "fx/soft-fail", "fx/slow-stream"];
let child;
let logs = "";

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (model, delta, extra = {}) => ({ id: "fx", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(name, { delayMs = 0 } = {}) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${FIXTURE_KEY}`) { res.writeHead(401).end("{}"); return; }
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id })) }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end("{}"); return; }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    hits.push(body.model);
    if (delayMs) await sleep(delayMs);

    if (body.model === "fx/soft-fail") {
      // HTTP 200, then an in-band error before any content.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse(chunk(body.model, { role: "assistant" })));
      res.end(sse({ error: { message: "Upstream overloaded, try again later" } }));
      return;
    }
    if (body.model === "fx/slow-stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 0; i < 100 && !res.destroyed; i++) {
        res.write(sse(chunk(body.model, { content: `part ${i} ` })));
        await sleep(100);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    const content = `ok from ${name}`;
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse(chunk(body.model, { role: "assistant", content })));
      res.write(sse({ ...chunk(body.model, {}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
      res.end("data: [DONE]\n\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "fx", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
  });
  return { name, hits, server };
}

const slow = fixture("slow", { delayMs: 400 });
const fast = fixture("fast");
for (const f of [slow, fast]) await new Promise((r) => f.server.listen(0, "127.0.0.1", r));

const portProbe = http.createServer();
await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
const port = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
const base = `http://127.0.0.1:${port}`;
let cookie = "";

async function call(route, { method, body, key, headers = {}, signal } = {}) {
  return fetch(base + route, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal || AbortSignal.timeout(30000),
  });
}
async function json(route, opts) {
  const res = await call(route, opts);
  const text = await res.text();
  assert.ok(res.ok, `${route}: ${res.status} ${text.slice(0, 500)}`);
  return { res, data: JSON.parse(text) };
}
const chat = (key, model, extra = {}, headers = {}) => call("/v1/chat/completions", { key, headers, body: { model, messages: [{ role: "user", content: "hello" }], stream: false, ...extra } });

try {
  child = spawn(process.execPath, [path.join(pkg, "app/server.js")], {
    cwd: pkg,
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", DATA_DIR: dataDir, INITIAL_PASSWORD: "e2e-local-fixture-password", NEXT_TELEMETRY_DISABLED: "1", STREAM_KEEPALIVE_MS: "0", ENABLE_REQUEST_LOGS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { logs += b; });
  child.stderr.on("data", (b) => { logs += b; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/dashboard", { signal: AbortSignal.timeout(1000) }); ready = true; break; } catch {}
    await sleep(300);
  }
  assert.ok(ready, "server failed to boot");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "e2e-local-fixture-password" }) });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  // Two accounts of the same provider: the slow one first in priority.
  for (const f of [slow, fast]) {
    await json("/api/providers", { body: { provider: "red-router", name: `E2E ${f.name}`, apiKey: FIXTURE_KEY, providerSpecificData: { baseUrl: `http://127.0.0.1:${f.server.address().port}` } } });
  }
  const { data: key } = await json("/api/keys", { body: { name: "E2E client" } });

  // 1. Forced reasoning level.
  const forced = await chat(key.key, "red-router/fx/ok", {}, { "x-red-router-reasoning": "high" });
  assert.equal(forced.status, 200, await forced.clone().text());
  assert.match(forced.headers.get("x-redrouter-reasoning") || "", /->high; cause=header/);
  console.log("PASS 1: forced reasoning level reported");

  // 2. Combo members, parameters and catalog version.
  const { data: combo } = await json("/api/combos", { body: { name: "e2e-combo", models: ["red-router/fx/soft-fail", "red-router/fx/ok"] } });
  const { res: list1, data: catalog1 } = await json("/v1/models", { key: key.key });
  const entry = catalog1.data.find((m) => m.id === "e2e-combo");
  assert.ok(entry, "combo missing from /v1/models");
  assert.equal(entry.members?.length, 2, "combo members");
  const version1 = list1.headers.get("x-redrouter-catalog-version");
  assert.ok(version1, "catalog version header");
  console.log("PASS 2a: combo listed with members");

  // 3. Soft failure → next member.
  const soft = await call("/v1/chat/completions", { key: key.key, body: { model: "e2e-combo", messages: [{ role: "user", content: "hello" }], stream: true } });
  const softText = await soft.text();
  assert.equal(soft.status, 200, softText.slice(0, 500));
  assert.match(softText, /ok from (fast|slow)/, "fell back to fx/ok");
  assert.ok([...slow.hits, ...fast.hits].includes("fx/soft-fail"), "soft-failing member was tried first");
  console.log("PASS 3: HTTP-200 failure fell back to the next combo member");

  await json(`/api/combos/${combo.id}`, { method: "PUT", body: { models: ["red-router/fx/ok"] } });
  const { res: list2 } = await json("/v1/models", { key: key.key });
  assert.notEqual(list2.headers.get("x-redrouter-catalog-version"), version1, "catalog version must change with the combo");
  console.log("PASS 2b: catalog version changed with the combo");

  // 4. Client disconnect mid-stream.
  const abort = new AbortController();
  const streaming = await call("/v1/chat/completions", { key: key.key, signal: abort.signal, body: { model: "red-router/fx/slow-stream", messages: [{ role: "user", content: "hello" }], stream: true } });
  const reader = streaming.body.getReader();
  await reader.read();
  abort.abort();
  let aborted = false;
  for (let i = 0; i < 40 && !aborted; i++) {
    await sleep(500);
    const res = await call("/api/usage/request-details?status=aborted&pageSize=20");
    aborted = res.ok && (await res.text()).includes("fx/slow-stream");
  }
  assert.ok(aborted, "aborted stream recorded");
  console.log("PASS 4: client disconnect recorded as aborted");

  // 5. Health strategy prefers the faster account.
  await json("/api/settings", { method: "PATCH", body: { fallbackStrategy: "health" } });
  // Untried accounts go first, so the slow one gets its first sample here.
  for (let i = 0; i < 2; i++) assert.equal((await chat(key.key, "red-router/fx/ok")).status, 200);
  const before = { slow: slow.hits.filter((m) => m === "fx/ok").length, fast: fast.hits.filter((m) => m === "fx/ok").length };
  for (let i = 0; i < 20; i++) assert.equal((await chat(key.key, "red-router/fx/ok")).status, 200);
  const fastHits = fast.hits.filter((m) => m === "fx/ok").length - before.fast;
  const slowHits = slow.hits.filter((m) => m === "fx/ok").length - before.slow;
  // 5% of picks explore the other account: about 1 in 20. 15 of 20 fails only
  // on 6+ explores (p < 0.001); 6 of 8 failed on 2 (p ≈ 0.04).
  assert.ok(fastHits >= 15, `health strategy should favour the fast account (fast ${fastHits}, slow ${slowHits})`);
  console.log(`PASS 5: health strategy sent ${fastHits}/20 to the fast account`);

  // 6. Access control.
  await json("/api/models/disabled", { body: { providerAlias: "red-router", ids: ["fx/ok"] } });
  const disabled = await chat(key.key, "red-router/fx/ok");
  assert.equal(disabled.status, 403);
  assert.equal(disabled.headers.get("x-9router-reason"), "model_disabled");
  await json("/api/models/disabled?providerAlias=red-router&id=fx/ok", { method: "DELETE" });

  await json(`/api/keys/${key.id}`, { method: "PUT", body: { modelAccess: { mode: "deny", patterns: ["*slow*"] } } });
  const denied = await chat(key.key, "red-router/fx/slow-stream");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-9router-reason"), "model_not_allowed");
  const { data: filtered } = await json("/v1/models", { key: key.key });
  assert.ok(!filtered.data.some((m) => m.id.includes("slow-stream")), "denied model hidden from /v1/models");

  await json(`/api/keys/${key.id}`, { method: "PUT", body: { modelAccess: null, limits: { rpm: 1 } } });
  assert.equal((await chat(key.key, "red-router/fx/ok")).status, 200);
  const limited = await chat(key.key, "red-router/fx/ok");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("x-9router-reason"), "api_key_limit");
  assert.ok(Number(limited.headers.get("retry-after")) > 0, "Retry-After");
  console.log("PASS 6: disabled model 403, key rule 403, key limit 429 with Retry-After");

  console.log("PASS: e2e routing");
} catch (error) {
  console.error(error);
  console.error(logs.slice(-8000));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
  for (const f of [slow, fast]) { f.server.closeAllConnections(); await new Promise((r) => f.server.close(r)); }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
