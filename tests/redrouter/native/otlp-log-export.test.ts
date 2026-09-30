import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install; the collector is a mocked fetch, nothing touches the network.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-otlp-"));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENCRYPTION_KEY = "otlp-log-export-test-key";
delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const destinationsDb = await import("../../../src/lib/db/logExportDestinations.ts");
const secrets = await import("../../../src/lib/logExport/secrets.ts");
const runner = await import("../../../src/lib/logExport/runner.ts");
const registry = await import("../../../src/lib/logExport/registry.ts");
const otlp = await import("../../../src/lib/logExport/destinations/otlp.ts");

import type { LogExportRecord } from "../../../src/lib/logExport/types.ts";

after(() => {
  registry.__resetLogExportDestinationTypesForTest();
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

function record(overrides: Partial<LogExportRecord> = {}): LogExportRecord {
  return {
    id: "req-1",
    timestamp: "2026-09-29T12:00:00.123Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "claude-opus-5",
    requestedModel: "smart",
    provider: "anthropic",
    providerDisplay: "Anthropic",
    account: "owner@example.org",
    connectionId: "conn-1",
    duration: 1240,
    tokensIn: 142,
    tokensOut: 38,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    tokensCompressed: 0,
    cacheSource: "upstream",
    requestType: "chat",
    sourceFormat: "openai",
    targetFormat: "claude",
    apiKeyId: "key-1",
    apiKeyName: "prod key",
    comboName: null,
    comboStepId: null,
    comboExecutionKey: null,
    errorSummary: null,
    errorType: null,
    correlationId: null,
    sessionTag: null,
    modelPinned: false,
    detailState: null,
    hasRequestBody: true,
    hasResponseBody: true,
    hasPipelineDetails: false,
    requestBody: "SECRET PROMPT: my password is hunter2",
    responseBody: "SECRET COMPLETION",
    pipelineRouteDecision: null,
    pipelineClientRequest: "SECRET CLIENT REQUEST",
    pipelineOpenaiRequest: null,
    pipelineProviderRequest: null,
    pipelineProviderResponse: null,
    pipelineClientResponse: null,
    pipelineError: "SECRET PIPELINE ERROR",
    bodiesTruncated: false,
    costUsd: 0.0123,
    ...overrides,
  };
}

const ENDPOINT = "https://collector.example.com:4318";

// --- body shape -------------------------------------------------------------------------------

test("one call log becomes one OTLP log record with the exact field names", () => {
  const body = otlp.buildOtlpLogsRequest([record()], {
    serviceName: "red-router",
    nowMs: 1_800_000_000_000,
  });

  assert.deepEqual(Object.keys(body), ["resourceLogs"]);
  const [resourceLogs] = body.resourceLogs;
  assert.deepEqual(Object.keys(resourceLogs).sort(), ["resource", "scopeLogs"]);
  const resourceAttributes = Object.fromEntries(
    resourceLogs.resource.attributes.map((a) => [
      a.key,
      "stringValue" in a.value ? a.value.stringValue : "",
    ])
  );
  assert.equal(resourceAttributes["service.name"], "red-router");
  assert.match(resourceAttributes["service.version"], /^\d+\.\d+\.\d+/);

  const [scope] = resourceLogs.scopeLogs;
  assert.equal(scope.scope.name, "red-router.call-logs");
  assert.equal(scope.logRecords.length, 1);

  const [log] = scope.logRecords;
  assert.deepEqual(Object.keys(log).sort(), [
    "attributes",
    "body",
    "observedTimeUnixNano",
    "severityNumber",
    "severityText",
    "timeUnixNano",
  ]);
  // 2026-09-29T12:00:00.123Z in ms * 1e6, as a decimal string (int64 does not survive JSON numbers).
  assert.equal(log.timeUnixNano, String(Date.parse("2026-09-29T12:00:00.123Z") * 1_000_000));
  assert.equal(typeof log.timeUnixNano, "string");
  assert.equal(log.observedTimeUnixNano, "1800000000000000000");
  assert.equal(log.severityNumber, 9);
  assert.equal(log.severityText, "INFO");
  assert.deepEqual(log.body, { stringValue: "call_log" });

  assert.deepEqual(log.attributes, [
    { key: "provider", value: { stringValue: "anthropic" } },
    { key: "model", value: { stringValue: "claude-opus-5" } },
    { key: "status", value: { intValue: "200" } },
    { key: "latency_ms", value: { intValue: "1240" } },
    { key: "tokens_in", value: { intValue: "142" } },
    { key: "tokens_out", value: { intValue: "38" } },
    { key: "tokens", value: { intValue: "180" } },
    { key: "cost_usd", value: { doubleValue: 0.0123 } },
    { key: "request_id", value: { stringValue: "req-1" } },
  ]);
});

test("severity follows the HTTP status", () => {
  assert.deepEqual(otlp.severityForStatus(200), { number: 9, text: "INFO" });
  assert.deepEqual(otlp.severityForStatus(302), { number: 9, text: "INFO" });
  assert.deepEqual(otlp.severityForStatus(429), { number: 13, text: "WARN" });
  assert.deepEqual(otlp.severityForStatus(503), { number: 17, text: "ERROR" });
  assert.deepEqual(otlp.severityForStatus(null), { number: 0, text: "UNSPECIFIED" });
});

test("nothing from a body, account, key or error message reaches the wire", () => {
  const wire = JSON.stringify(
    otlp.buildOtlpLogsRequest([record({ errorSummary: "upstream returned SECRET ERROR TEXT" })], {
      serviceName: "red-router",
    })
  );
  for (const leaked of [
    "SECRET",
    "hunter2",
    "owner@example.org",
    "prod key",
    "key-1",
    "conn-1",
    "/v1/chat/completions",
  ]) {
    assert.equal(wire.includes(leaked), false, `wire leaked ${leaked}`);
  }
});

test("missing fields are omitted rather than sent as null, and a bad timestamp falls back", () => {
  const log = otlp.buildOtlpLogsRequest(
    [
      record({
        provider: null,
        model: null,
        status: null,
        duration: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: undefined,
        timestamp: "garbage",
      }),
    ],
    { serviceName: "s", nowMs: 5_000 }
  ).resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.deepEqual(log.attributes, [{ key: "request_id", value: { stringValue: "req-1" } }]);
  assert.equal(log.timeUnixNano, "5000000000");
  assert.equal(log.severityText, "UNSPECIFIED");
});

// --- config, secrets, SSRF --------------------------------------------------------------------

test("the destination is registered and its form comes from the descriptor", () => {
  assert.equal(registry.isKnownLogExportDestinationType("otlp"), true);
  const descriptor = registry.describeLogExportDestinationTypes().find((d) => d.id === "otlp");
  assert.deepEqual(
    descriptor?.fields.map((f) => [f.key, f.type, f.secret === true]),
    [
      ["endpoint", "text", false],
      ["headers", "textarea", true],
      ["serviceName", "text", false],
      ["endpointIsFull", "boolean", false],
    ]
  );
});

test("endpoints must be https (http only for loopback) and pass the egress guard", () => {
  const parse = (endpoint: string) => otlp.otlpConfigSchema.safeParse({ endpoint });
  assert.equal(parse(ENDPOINT).success, true);
  assert.equal(parse(`${ENDPOINT}/v1/logs`).success, true);

  const refused = [
    "http://collector.example.com:4318", // plain http off-box
    "ftp://collector.example.com",
    "not a url",
    "https://user:pass@collector.example.com", // embedded credentials
    "https://10.0.0.5:4318", // private
    "https://192.168.1.10",
    "https://169.254.169.254/latest", // cloud metadata
    "https://localhost:4318", // loopback needs the private-URL opt-in
    "http://127.0.0.1:4318",
    "http://[::1]:4318",
  ];
  for (const endpoint of refused) {
    assert.equal(parse(endpoint).success, false, `${endpoint} must be refused`);
  }
});

test("a loopback collector is allowed over http only with the operator's private-URL opt-in", () => {
  process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";
  try {
    assert.equal(
      otlp.otlpConfigSchema.safeParse({ endpoint: "http://127.0.0.1:4318" }).success,
      true
    );
    assert.equal(
      otlp.otlpConfigSchema.safeParse({ endpoint: "http://localhost:4318" }).success,
      true
    );
    // The opt-in never legalises plain http off the box, or metadata endpoints.
    assert.equal(
      otlp.otlpConfigSchema.safeParse({ endpoint: "http://collector.example.com" }).success,
      false
    );
    assert.equal(
      otlp.otlpConfigSchema.safeParse({ endpoint: "https://169.254.169.254" }).success,
      false
    );
  } finally {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  }
});

test("the send-time guard refuses a private target even when the schema was bypassed", async () => {
  const client = otlp.otlpDestination.createClient({
    endpoint: "https://127.0.0.1:1",
    headers: "",
    serviceName: "red-router",
  });
  await assert.rejects(client.send([record()]), /Destination blocked by the egress policy/);
  const test = await client.test();
  assert.equal(test.ok, false);
  assert.match(test.detail, /blocked by the egress policy/);
});

test("header lines are validated and reserved headers cannot be overridden", () => {
  const parse = (headers: string) =>
    otlp.otlpConfigSchema.safeParse({ endpoint: ENDPOINT, headers });
  assert.equal(parse("Authorization: Bearer abc\nX-Tenant: red").success, true);
  assert.equal(parse("").success, true);
  assert.equal(parse("no separator").success, false);
  assert.equal(parse("Content-Type: text/plain").success, false);
  assert.equal(parse("Host: evil.example").success, false);
  assert.equal(parse("Bad Name: x").success, false);
  assert.equal(parse(Array.from({ length: 21 }, (_, i) => `X-${i}: v`).join("\n")).success, false);
});

test("header secrets are encrypted at rest and redacted in API views", () => {
  assert.deepEqual(otlp.otlpDestination.secretFields, ["headers"]);
  const stored = secrets.encryptDestinationConfig("otlp", {
    endpoint: ENDPOINT,
    headers: "Authorization: Bearer super-secret-token",
  });
  assert.equal(String(stored.headers).includes("super-secret-token"), false);
  assert.equal(stored.endpoint, ENDPOINT);
  const redacted = secrets.redactDestinationConfig("otlp", stored);
  assert.equal(redacted.headers, secrets.SECRET_PLACEHOLDER);
  assert.equal(
    (secrets.decryptDestinationConfig("otlp", stored) as { headers: string }).headers,
    "Authorization: Bearer super-secret-token"
  );
});

// --- client over a mocked fetch ---------------------------------------------------------------

type Call = { url: string; init: RequestInit };
function collector(responses: Array<Response | Error> = []) {
  const calls: Call[] = [];
  const httpFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response("{}", { status: 200 });
  };
  return { calls, httpFetch };
}
const config = {
  endpoint: ENDPOINT,
  headers: "Authorization: Bearer tok\nX-Tenant: red",
  serviceName: "rr",
};
const bodyOf = (call: Call) => JSON.parse(String(call.init.body));

test("POSTs JSON to {endpoint}/v1/logs with the configured headers", async () => {
  const { calls, httpFetch } = collector();
  await otlp.createOtlpClientForTest(config, httpFetch).send([record()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/v1/logs`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    Authorization: "Bearer tok",
    "X-Tenant": "red",
    "Content-Type": "application/json",
  });
  assert.equal(bodyOf(calls[0]).resourceLogs[0].resource.attributes[0].value.stringValue, "rr");

  const explicit = collector();
  await otlp
    .createOtlpClientForTest({ ...config, endpoint: `${ENDPOINT}/v1/logs/` }, explicit.httpFetch)
    .send([record()]);
  assert.equal(explicit.calls[0].url, `${ENDPOINT}/v1/logs`, "an explicit /v1/logs is not doubled");
});

test("large batches are split into chunks of at most OTLP_CHUNK_SIZE records", async () => {
  const { calls, httpFetch } = collector();
  const records = Array.from({ length: otlp.OTLP_CHUNK_SIZE * 2 + 7 }, (_, i) =>
    record({ id: `r${i}` })
  );
  await otlp.createOtlpClientForTest(config, httpFetch).send(records);
  assert.deepEqual(
    calls.map((call) => bodyOf(call).resourceLogs[0].scopeLogs[0].logRecords.length),
    [otlp.OTLP_CHUNK_SIZE, otlp.OTLP_CHUNK_SIZE, 7]
  );
});

test("retries 429/503 with Retry-After, then gives up; 400 is terminal; failures throw", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  const retried = collector([
    new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    new Response("", { status: 503 }),
  ]);
  await otlp.createOtlpClientForTest(config, retried.httpFetch, sleep).send([record()]);
  assert.equal(retried.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]);

  const exhausted = collector([503, 503, 503].map((status) => new Response("", { status })));
  await assert.rejects(
    otlp.createOtlpClientForTest(config, exhausted.httpFetch, sleep).send([record()]),
    /HTTP 503/
  );
  assert.equal(exhausted.calls.length, 3);

  const rejected = collector([new Response("bad payload", { status: 400 })]);
  await assert.rejects(
    otlp.createOtlpClientForTest(config, rejected.httpFetch, sleep).send([record()]),
    /HTTP 400: bad payload/
  );
  assert.equal(rejected.calls.length, 1, "a 400 is not retried");
});

test("a partial-success response is delivered, not retried forever", async () => {
  const { calls, httpFetch } = collector([
    new Response(
      JSON.stringify({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "x" } }),
      { status: 200 }
    ),
  ]);
  await otlp.createOtlpClientForTest(config, httpFetch).send([record(), record({ id: "req-2" })]);
  assert.equal(calls.length, 1);
});

test("test() sends an empty export and reports the collector status", async () => {
  const ok = collector();
  const result = await otlp.createOtlpClientForTest(config, ok.httpFetch).test();
  assert.equal(result.ok, true);
  assert.deepEqual(bodyOf(ok.calls[0]).resourceLogs[0].scopeLogs[0].logRecords, []);

  const denied = collector([new Response("unauthorized", { status: 401 })]);
  const failed = await otlp.createOtlpClientForTest(config, denied.httpFetch).test();
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /HTTP 401/);
  assert.equal(failed.detail.includes("tok"), false, "credentials never appear in the result");
});

// --- through the runner -----------------------------------------------------------------------

beforeEach(() => {
  resetDbInstance();
  const db = getDbInstance();
  db.prepare("DELETE FROM call_logs").run();
  db.prepare("DELETE FROM log_export_destinations").run();
  db.prepare("DELETE FROM request_cost_ledger").run();
});

test("the runner drains call logs through the OTLP client in batchSize batches, with costs", async () => {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, duration, tokens_in, tokens_out)
     VALUES (?, ?, 'POST', '/v1/chat/completions', ?, 'claude-opus-5', 'anthropic', 100, 10, 20)`
  );
  for (let i = 0; i < 5; i++) {
    insert.run(
      `log-${i}`,
      new Date(Date.UTC(2026, 8, 29, 12, 0, i)).toISOString(),
      i === 4 ? 503 : 200
    );
  }
  db.prepare(
    `INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp, request_id)
     VALUES ('k', 'anthropic', 'claude-opus-5', 0.5, ?, 'log-1')`
  ).run(new Date().toISOString());

  const { calls, httpFetch } = collector();
  registry.__registerLogExportDestinationTypeForTest({
    ...otlp.otlpDestination,
    id: "otlp-mocked",
    createClient: (cfg) => otlp.createOtlpClientForTest(cfg, httpFetch),
  });

  const destination = destinationsDb.createLogExportDestination({
    name: "collector",
    type: "otlp-mocked",
    enabled: true,
    batchSize: 2,
    includeBodies: true,
    config: secrets.encryptDestinationConfig("otlp-mocked", config),
  });
  // secretFields come from the registered type, so the header was encrypted before storage.
  assert.equal(
    JSON.stringify(destinationsDb.getLogExportDestination(destination.id)?.config).includes(
      "Bearer tok"
    ),
    false
  );

  const result = await runner.runSingleLogExport(destination.id);
  assert.equal(result?.success, true, result?.error ?? "");
  assert.equal(result?.exported, 5);
  assert.equal(result?.batches, 3);
  assert.equal(result?.pendingAfterRun, 0);

  const sent = calls.flatMap((call) => bodyOf(call).resourceLogs[0].scopeLogs[0].logRecords);
  assert.equal(calls.length, 3);
  assert.equal(sent.length, 5);
  assert.equal(
    calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer tok"
  );

  type Log = (typeof sent)[number];
  const attrs = (log: Log) =>
    Object.fromEntries(log.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.equal(attrs(sent[1]).request_id, "log-1");
  assert.equal(attrs(sent[1]).cost_usd, 0.5, "cost is joined from the ledger");
  assert.equal("cost_usd" in attrs(sent[0]), false, "no ledger row, no cost attribute");
  assert.equal(sent[4].severityText, "ERROR");
  assert.equal(attrs(sent[4]).status, "503");
});

test("a failing collector keeps the cursor where it was", async () => {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, duration)
     VALUES ('only', ?, 'POST', '/v1/chat/completions', 200, 'm', 'p', 1)`
  ).run(new Date().toISOString());

  registry.__registerLogExportDestinationTypeForTest({
    ...otlp.otlpDestination,
    id: "otlp-failing",
    createClient: (cfg) =>
      otlp.createOtlpClientForTest(cfg, async () => new Response("no", { status: 400 })),
  });
  const destination = destinationsDb.createLogExportDestination({
    name: "broken",
    type: "otlp-failing",
    enabled: true,
    config: config,
  });
  const result = await runner.runSingleLogExport(destination.id);
  assert.equal(result?.success, false);
  assert.equal(result?.exported, 0);
  assert.equal(result?.pendingAfterRun, 1);
  assert.equal(destinationsDb.getLogExportDestination(destination.id)?.cursorRowId, 0);
});
