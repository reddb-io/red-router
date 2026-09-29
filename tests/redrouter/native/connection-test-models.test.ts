import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

// Real DB on a scratch install; only the upstream provider `fetch` is mocked.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-connection-test-models-"));
const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  REQUIRE_API_KEY: process.env.REQUIRE_API_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
};
process.env.DATA_DIR = dataDir;
delete process.env.INITIAL_PASSWORD;
delete process.env.REQUIRE_API_KEY;

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const route = await import("../../../src/app/api/providers/[id]/test-models/route.ts");

const originalFetch = globalThis.fetch;
const API_KEY = "sk-test-connection-key";
const UPSTREAM_SECRET = "sk-upstream-body-secret";
// Chat-completions models in the openai registry (the *-responses ones use another upstream path).
const OK_MODEL = "gpt-4o";
const REJECTED_MODEL = "gpt-4.1-nano";

type UpstreamCall = { url: string; model?: string };
let calls: UpstreamCall[] = [];
let inFlight = 0;
let maxInFlight = 0;

function installUpstream(handler?: (model: string | undefined, url: string) => Response | null) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let model: string | undefined;
    try {
      model = JSON.parse(String(init?.body ?? "{}")).model;
    } catch {
      model = undefined;
    }
    calls.push({ url, model });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const custom = handler?.(model, url);
      if (custom) return custom;
      if (model === REJECTED_MODEL) {
        return new Response(JSON.stringify({ error: { message: `bad key ${UPSTREAM_SECRET}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/embeddings")) {
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          model,
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }
      return Response.json({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
}

async function createConnection(overrides: Record<string, unknown> = {}) {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-test-models",
    apiKey: API_KEY,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
    ...overrides,
  });
  return String(connection.id);
}

async function call(id: string, body?: unknown, rawBody?: string) {
  const request = await makeManagementSessionRequest(
    `http://localhost/api/providers/${id}/test-models`,
    { method: "POST", body: body as Record<string, unknown> | undefined }
  );
  const finalRequest =
    rawBody === undefined
      ? request
      : new Request(request.url, { method: "POST", headers: request.headers, body: rawBody });
  const response = await route.POST(finalRequest, { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

type Probe = {
  model: string;
  kind: string;
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  skipped?: boolean;
};

function indexByModel(results: Probe[]): Map<string, Probe> {
  return new Map(results.map((entry) => [entry.model, entry]));
}

function resetStorage() {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(dataDir, { recursive: true });
}

beforeEach(() => {
  resetStorage();
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  delete process.env.INITIAL_PASSWORD;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("rejects unauthenticated callers with 401 before touching the connection", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-password";
  await settingsDb.updateSettings({ requireLogin: true, password: "" });
  installUpstream();
  const id = await createConnection();

  const response = await route.POST(
    new Request(`http://localhost/api/providers/${id}/test-models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ id }) }
  );

  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("unknown connection is a 404", async () => {
  installUpstream();
  const result = await call("does-not-exist", {});
  assert.equal(result.status, 404);
  assert.equal(calls.length, 0);
});

test("a disabled connection is a 409 and is not probed", async () => {
  installUpstream();
  const id = await createConnection({ isActive: false });
  const result = await call(id, {});
  assert.equal(result.status, 409);
  assert.equal(calls.length, 0);
});

test("invalid bodies are rejected with 400 and nothing is probed", async () => {
  installUpstream();
  const id = await createConnection();
  const bad: unknown[] = [
    { modelIds: [] },
    { modelIds: Array.from({ length: 51 }, (_, index) => `m-${index}`) },
    { modelIds: [""] },
    { modelIds: "gpt-5.6" },
    { concurrency: 4 },
    { concurrency: 0 },
    { timeoutMs: 30_001 },
    { timeoutMs: 10 },
    { unexpected: true },
  ];
  for (const body of bad) {
    const result = await call(id, body);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  const malformed = await call(id, undefined, "{not json");
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 0);
});

test("reports per-model results with the model kind and fixed error strings", async () => {
  installUpstream();
  const id = await createConnection();
  await modelsDb.addCustomModel(
    "openai",
    "test-embed-model",
    "Test Embed",
    "manual",
    "embeddings",
    ["embeddings"]
  );

  const result = await call(id, { modelIds: [OK_MODEL, "test-embed-model", REJECTED_MODEL] });
  assert.equal(result.status, 200);
  assert.equal(result.json.provider, "openai");
  assert.equal(result.json.connectionId, id);

  const byModel = indexByModel(result.json.results);
  assert.equal(result.json.results.length, byModel.size, "one result per model");
  assert.equal(result.json.results.length, 3);
  assert.ok(result.json.total > 3, "total counts every listed model");

  const ok = byModel.get(OK_MODEL);
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, "chat");
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.latencyMs, "number");
  assert.equal(ok.error, undefined);

  assert.equal(byModel.get("test-embed-model").kind, "embedding");
  assert.equal(byModel.get("test-embed-model").ok, true);

  const rejected = byModel.get(REJECTED_MODEL);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.error, "Upstream rejected the credentials");

  assert.deepEqual(result.json.summary, { ok: 2, failed: 1, skipped: 0 });
  assert.equal(result.text.includes(UPSTREAM_SECRET), false, "upstream bodies are never echoed");
  assert.equal(result.text.includes(API_KEY), false, "credentials are never echoed");
});

test("modelIds selects a subset, accepts provider-prefixed ids and flags unknown ids", async () => {
  installUpstream();
  const id = await createConnection();

  const result = await call(id, {
    modelIds: [OK_MODEL, `openai/${REJECTED_MODEL}`, "not-a-model"],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.results.length, 3);
  const byModel = indexByModel(result.json.results);
  assert.equal(byModel.get(OK_MODEL).ok, true);
  assert.equal(byModel.get(REJECTED_MODEL).ok, false);
  assert.equal(byModel.get("not-a-model").skipped, true);
  assert.equal(byModel.get("not-a-model").ok, false);
  assert.deepEqual(result.json.summary, { ok: 1, failed: 1, skipped: 1 });

  const probed = new Set(calls.map((entry) => entry.model));
  assert.deepEqual([...probed].sort(), [OK_MODEL, REJECTED_MODEL].sort());
  assert.equal(probed.has("not-a-model"), false, "unlisted ids are never dispatched");
});

test("a large catalog is capped at 50 models per call", async () => {
  installUpstream();
  const id = await createConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "openai",
    id,
    Array.from({ length: 60 }, (_, index) => ({
      id: `synced-model-${String(index).padStart(2, "0")}`,
      name: `Synced ${index}`,
    }))
  );

  const result = await call(id, {});
  assert.equal(result.status, 200);
  assert.ok(result.json.total > 50);
  assert.equal(result.json.truncated, true);
  assert.equal(result.json.limit, 50);
  assert.equal(result.json.results.length, 50);
  assert.ok(calls.length <= 50);
});

test("concurrency never exceeds the requested value (max 3)", async () => {
  installUpstream();
  const id = await createConnection();
  const ids = [OK_MODEL, "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5.4", REJECTED_MODEL];

  const result = await call(id, { modelIds: ids, concurrency: 3 });
  assert.equal(result.status, 200);
  assert.equal(result.json.results.length, ids.length);
  assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);

  maxInFlight = 0;
  calls = [];
  const sequential = await call(id, { modelIds: ids });
  assert.equal(sequential.status, 200);
  assert.equal(maxInFlight, 1, "the default is sequential");
});
