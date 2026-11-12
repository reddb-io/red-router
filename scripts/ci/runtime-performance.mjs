#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), "redrouter-runtime-bench-"));
const nextData = path.join(temp, "next-data");
const rustDatabase = path.join(temp, "rust.sqlite");
const clientKeySecret = "runtime-benchmark-api-key-secret-2026";
const storageKey = "runtime-benchmark-storage-key-2026-long-enough";
const providerKey = "runtime-benchmark-provider-key";
const adminKey = "runtime-benchmark-admin-key-long-enough";
const logs = new Map();
const children = [];

process.env.DATA_DIR = nextData;
process.env.API_KEY_SECRET = clientKeySecret;
process.env.STORAGE_ENCRYPTION_KEY = storageKey;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.REQUIRE_API_KEY = "true";

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function completionBody() {
  return {
    id: "chatcmpl-runtime-benchmark",
    object: "chat.completion",
    created: 1_794_000_000,
    model: "bench-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "benchmark response" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
  };
}

function streamChunks() {
  const base = {
    id: "chatcmpl-runtime-benchmark",
    object: "chat.completion.chunk",
    model: "bench-model",
  };
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "benchmark " }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "response" }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 },
    },
  ];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startUpstream() {
  let requests = 0;
  let peakInFlight = 0;
  let inFlight = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "bench-model", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    requests += 1;
    try {
      assert.equal(req.headers.authorization, `Bearer ${providerKey}`);
      const body = await readJson(req);
      assert.equal(body.model, "bench-model");
      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of streamChunks()) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionBody()));
      }
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    } finally {
      inFlight -= 1;
    }
  });
  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    stats: () => ({ requests, peak_in_flight: peakInFlight }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function captureLogs(name, child) {
  const lines = [];
  logs.set(name, lines);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      if (lines.length > 100) lines.splice(0, lines.length - 100);
    });
  }
}

function startProcess(name, command, args, env) {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureLogs(name, child);
  children.push(child);
  return { child, startedAt };
}

async function waitReady(name, url, processInfo) {
  let lastError = "not ready";
  while (performance.now() - processInfo.startedAt < 120_000) {
    if (processInfo.child.exitCode !== null) {
      throw new Error(`${name} exited before readiness\n${(logs.get(name) || []).join("\n")}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return performance.now() - processInfo.startedAt;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${name} readiness timed out: ${lastError}\n${(logs.get(name) || []).join("\n")}`
  );
}

function processTable() {
  const output = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite));
}

function processTreeRssMiB(rootPid) {
  const rows = processTable();
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (selected.has(ppid) && !selected.has(pid)) {
        selected.add(pid);
        changed = true;
      }
    }
  }
  const kib = rows.reduce((sum, [pid, , rss]) => sum + (selected.has(pid) ? rss : 0), 0);
  return rounded(kib / 1024);
}

function smallPayload(model, stream = false) {
  return {
    model,
    messages: [{ role: "user", content: "Return a short benchmark response." }],
    stream,
  };
}

function agentPayload(model) {
  const content = "Repository context and tool output. ".repeat(64);
  return {
    model,
    stream: false,
    messages: Array.from({ length: 64 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${content}`,
    })),
    tools: Array.from({ length: 16 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: "A deterministic coding-agent tool used by the benchmark.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, query: { type: "string" } },
          required: ["path"],
        },
      },
    })),
  };
}

async function oneRequest(target, payload) {
  const startedAt = performance.now();
  const response = await fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const firstByteMs = performance.now() - startedAt;
  const body = await response.text();
  const totalMs = performance.now() - startedAt;
  if (!response.ok)
    throw new Error(`${target.name} returned ${response.status}: ${body.slice(0, 500)}`);
  if (payload.stream === true) assert.match(body, /\[DONE\]/);
  else assert.equal(JSON.parse(body).choices?.[0]?.message?.content, "benchmark response");
  return { firstByteMs, totalMs };
}

async function warm(target, payload, count = 24) {
  await Promise.all(Array.from({ length: count }, () => oneRequest(target, payload)));
}

async function runTrial(target, payload, requestCount, concurrency) {
  const timings = [];
  let cursor = 0;
  let peakRssMiB = processTreeRssMiB(target.pid);
  const sampler = setInterval(() => {
    peakRssMiB = Math.max(peakRssMiB, processTreeRssMiB(target.pid));
  }, 500);
  const startedAt = performance.now();
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= requestCount) return;
          timings.push(await oneRequest(target, payload));
        }
      })
    );
  } finally {
    clearInterval(sampler);
  }
  const wallMs = performance.now() - startedAt;
  peakRssMiB = Math.max(peakRssMiB, processTreeRssMiB(target.pid));
  return { timings, wallMs, peakRssMiB };
}

function summarizeTrials(trials) {
  const totals = trials
    .flatMap((trial) => trial.timings.map((timing) => timing.totalMs))
    .sort((a, b) => a - b);
  const firstBytes = trials
    .flatMap((trial) => trial.timings.map((timing) => timing.firstByteMs))
    .sort((a, b) => a - b);
  const requests = totals.length;
  const wallMs = trials.reduce((sum, trial) => sum + trial.wallMs, 0);
  return {
    requests,
    throughput_rps: rounded(requests / (wallMs / 1000)),
    latency_ms: {
      p50: rounded(percentile(totals, 50)),
      p95: rounded(percentile(totals, 95)),
      p99: rounded(percentile(totals, 99)),
      max: rounded(totals.at(-1) || 0),
    },
    ttfb_ms: {
      p50: rounded(percentile(firstBytes, 50)),
      p95: rounded(percentile(firstBytes, 95)),
      p99: rounded(percentile(firstBytes, 99)),
    },
    peak_rss_mib: Math.max(...trials.map((trial) => trial.peakRssMiB)),
  };
}

async function compareCase(spec, next, rust) {
  const payloads = {
    next: spec.payload(next.model),
    rust: spec.payload(rust.model),
  };
  await warm(next, payloads.next);
  await warm(rust, payloads.rust);
  const trials = { next: [], rust: [] };
  for (let round = 0; round < spec.rounds; round += 1) {
    const order = round % 2 === 0 ? [next, rust] : [rust, next];
    for (const target of order) {
      trials[target.name].push(
        await runTrial(target, payloads[target.name], spec.requests, spec.concurrency)
      );
    }
  }
  const nextSummary = summarizeTrials(trials.next);
  const rustSummary = summarizeTrials(trials.rust);
  return {
    name: spec.name,
    concurrency: spec.concurrency,
    payload_bytes: Buffer.byteLength(JSON.stringify(payloads.next)),
    next: nextSummary,
    rust: rustSummary,
    rust_vs_next: {
      throughput_multiplier: rounded(rustSummary.throughput_rps / nextSummary.throughput_rps),
      p95_latency_reduction_percent: rounded(
        (1 - rustSummary.latency_ms.p95 / nextSummary.latency_ms.p95) * 100
      ),
      peak_rss_reduction_percent: rounded(
        (1 - rustSummary.peak_rss_mib / nextSummary.peak_rss_mib) * 100
      ),
    },
  };
}

function markdown(report) {
  const lines = [
    "## Red Router runtime performance",
    "",
    `Production A/B on \`${report.runner}\`; same local upstream, SQLite persistence, client authentication and usage accounting.`,
    "",
    `Startup: Next ${report.startup_ms.next} ms / Rust ${report.startup_ms.rust} ms. Idle RSS: Next ${report.idle_rss_mib.next} MiB / Rust ${report.idle_rss_mib.rust} MiB.`,
    "",
    "| Scenario | Concurrency | Next req/s | Rust req/s | Speedup | Next p95 | Rust p95 | Next peak RSS | Rust peak RSS |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of report.cases) {
    lines.push(
      `| ${item.name} | ${item.concurrency} | ${item.next.throughput_rps} | ${item.rust.throughput_rps} | ${item.rust_vs_next.throughput_multiplier}x | ${item.next.latency_ms.p95} ms | ${item.rust.latency_ms.p95} ms | ${item.next.peak_rss_mib} MiB | ${item.rust.peak_rss_mib} MiB |`
    );
  }
  lines.push("", "Raw distributions are available in `runtime-performance.json`.", "");
  return lines.join("\n");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) child.kill("SIGKILL");
}

let upstream;
try {
  assert.ok(
    existsSync(path.join(root, ".build", "next", "standalone", "server.js")),
    "Next standalone build is missing"
  );
  assert.ok(
    existsSync(path.join(root, "rust", "red-routerd", "target", "release", "red-routerd")),
    "Rust release binary is missing"
  );

  upstream = await startUpstream();
  const providersDb = await import("../../src/lib/db/providers.ts");
  const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
  const coreDb = await import("../../src/lib/db/core.ts");
  const providerId = "openai-compatible-chat-runtime-benchmark";
  await providersDb.createProviderNode({
    id: providerId,
    type: "openai-compatible",
    name: "Runtime benchmark",
    prefix: "bench",
    apiType: "chat",
    baseUrl: upstream.url,
    chatPath: "/chat/completions",
  });
  await providersDb.createProviderConnection({
    provider: providerId,
    authType: "apikey",
    name: "runtime-benchmark",
    apiKey: providerKey,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: upstream.url, apiType: "chat", chatPath: "/chat/completions" },
  });
  const client = await apiKeysDb.createApiKey("Runtime benchmark", "0000000000000001");
  coreDb.closeDbInstance();

  const nextPort = await freePort();
  const rustPort = await freePort();
  const commonEnv = {
    API_KEY_SECRET: clientKeySecret,
    STORAGE_ENCRYPTION_KEY: storageKey,
    DISABLE_SQLITE_AUTO_BACKUP: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    APP_LOG_LEVEL: "silent",
  };
  const nextProcess = startProcess(
    "next",
    process.execPath,
    [path.join(root, ".build", "next", "standalone", "server.js")],
    {
      ...commonEnv,
      NODE_ENV: "production",
      DATA_DIR: nextData,
      PORT: String(nextPort),
      DASHBOARD_PORT: String(nextPort),
      API_PORT: String(nextPort),
      HOSTNAME: "127.0.0.1",
      REQUIRE_API_KEY: "true",
      INITIAL_PASSWORD: "",
      OMNIROUTE_E2E_BOOTSTRAP_MODE: "open",
      OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
      OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK: "true",
      OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK: "true",
      OMNIROUTE_HIDE_HEALTHCHECK_LOGS: "true",
    }
  );
  const rustProcess = startProcess(
    "rust",
    path.join(root, "rust", "red-routerd", "target", "release", "red-routerd"),
    [],
    {
      ...commonEnv,
      RED_ROUTER_LISTEN: `127.0.0.1:${rustPort}`,
      RED_ROUTER_DB_BACKEND: "sqlite",
      RED_ROUTER_DATABASE_URL: `sqlite://${rustDatabase}?mode=rwc`,
      RED_ROUTER_UPSTREAM_URL: `${upstream.url}/chat/completions`,
      RED_ROUTER_CLIENT_KEY: client.key,
      RED_ROUTER_PROVIDER_KEY: providerKey,
      RED_ROUTER_ADMIN_KEY: adminKey,
      RED_ROUTER_ALLOW_PRIVATE_UPSTREAM: "1",
      RED_ROUTER_DISABLE_UPSTREAM_RETRY: "1",
    }
  );
  const [nextStartup, rustStartup] = await Promise.all([
    waitReady("next", `http://127.0.0.1:${nextPort}/api/monitoring/health`, nextProcess),
    waitReady("rust", `http://127.0.0.1:${rustPort}/healthz`, rustProcess),
  ]);

  const targets = {
    next: {
      name: "next",
      pid: nextProcess.child.pid,
      url: `http://127.0.0.1:${nextPort}/v1/chat/completions`,
      key: client.key,
      model: "bench/bench-model",
    },
    rust: {
      name: "rust",
      pid: rustProcess.child.pid,
      url: `http://127.0.0.1:${rustPort}/v1/chat/completions`,
      key: client.key,
      model: "bench-model",
    },
  };
  await warm(targets.next, smallPayload(targets.next.model), 32);
  await warm(targets.rust, smallPayload(targets.rust.model), 32);
  const idleRss = {
    next: processTreeRssMiB(targets.next.pid),
    rust: processTreeRssMiB(targets.rust.pid),
  };
  const specs = [
    {
      name: "small-json",
      concurrency: 1,
      requests: 120,
      rounds: 3,
      payload: (model) => smallPayload(model),
    },
    {
      name: "parallel-agents",
      concurrency: 32,
      requests: 320,
      rounds: 3,
      payload: (model) => smallPayload(model),
    },
    { name: "agentic-128k", concurrency: 16, requests: 96, rounds: 3, payload: agentPayload },
    {
      name: "streaming-agents",
      concurrency: 32,
      requests: 160,
      rounds: 3,
      payload: (model) => smallPayload(model, true),
    },
  ];
  const cases = [];
  for (const spec of specs) cases.push(await compareCase(spec, targets.next, targets.rust));
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    git_sha: process.env.GITHUB_SHA || null,
    runner: `${os.platform()} ${os.arch()} / ${os.cpus().length} logical CPUs`,
    methodology: {
      next: "Next.js standalone production server with SQLite, API-key auth and compatible provider",
      rust: "red-routerd release with Rust control plane, SQLite, API-key auth and native usage accounting",
      upstream: "same loopback OpenAI-compatible fixture; no model latency",
      rounds: 3,
      ordering: "alternating A/B order per round",
    },
    startup_ms: { next: rounded(nextStartup), rust: rounded(rustStartup) },
    idle_rss_mib: idleRss,
    cases,
    upstream: upstream.stats(),
  };
  const reportPath = path.join(root, "runtime-performance.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = markdown(report);
  process.stdout.write(`${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
} finally {
  await Promise.all(children.map(stopChild));
  await upstream?.close();
  rmSync(temp, { recursive: true, force: true });
}

