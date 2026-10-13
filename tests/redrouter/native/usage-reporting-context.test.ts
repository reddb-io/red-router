import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskDir = mkdtempSync(join(tmpdir(), "redrouter-report-context-"));
process.env.DATA_DIR = taskDir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { recordLedgerEntrySafe, recordLedgerEntries } =
  await import("../../../src/lib/db/costLedger.ts");
const { createUsageSink, listUsageDeliveries, getUsageSink } =
  await import("../../../src/lib/db/usageSinks.ts");
const { aggregateUsageSink } = await import("../../../src/lib/usageSinks/engine.ts");
const { usageAttributesSchema, snapshotUsageAttributes } =
  await import("../../../src/lib/usage/reportingAttributes.ts");
const { recordStreamingCost } =
  await import("../../../open-sse/handlers/chatCore/streamingCost.ts");

after(() => {
  delete process.env.REDROUTER_USAGE_ATTRIBUTES_JSON;
  delete process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS;
  resetDbInstance();
  rmSync(taskDir, { recursive: true, force: true });
});

test("report metadata is bounded, declarative and rejects credentials and conflicting instance identity", () => {
  process.env.REDROUTER_USAGE_ATTRIBUTES_JSON = JSON.stringify({ region: "region-a" });
  assert.deepEqual(snapshotUsageAttributes({ project_id: "project-a" }), {
    project_id: "project-a",
  });
  assert.throws(() => snapshotUsageAttributes({ region: "region-b" }));
  assert.equal(usageAttributesSchema.safeParse({ access_token: "credential" }).success, false);
  assert.equal(
    usageAttributesSchema.safeParse({ nested: { value: "unsupported" } }).success,
    false
  );
  assert.equal(
    usageAttributesSchema.safeParse({ quantity: Number.POSITIVE_INFINITY }).success,
    false
  );
  assert.equal(usageAttributesSchema.safeParse({ label: "x".repeat(257) }).success, false);
  assert.equal(
    usageAttributesSchema.safeParse(
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field_${i}`, i]))
    ).success,
    false
  );
});

test("key creation and usage preserve the original binding through restart, retry and environment changes", async () => {
  process.env.REDROUTER_USAGE_ATTRIBUTES_JSON = JSON.stringify({ region: "region-a" });
  const key = await createApiKey("resource client", "report-test-machine", [], {
    usageAttributes: { project_id: "project-a", resource_id: "resource-a" },
  });
  const sink = createUsageSink({
    name: "Reporting",
    url: "https://example.test/report",
    secretEncrypted: "fixture",
    mode: "instant",
    enabled: true,
  });
  const entry = {
    apiKeyId: key.id,
    provider: "example",
    model: "unpriced",
    requestId: "request-a",
    tenantId: "tenant-a",
    tokensInput: 100,
    tokensOutput: 20,
    tokensCacheRead: 15,
    tokensCacheCreation: 5,
    tokensReasoning: 3,
    amountUsd: 0,
    pricingKnown: false,
  };
  assert.equal(recordLedgerEntrySafe(entry), "recorded");
  assert.equal(recordLedgerEntrySafe(entry), "recorded");
  process.env.REDROUTER_USAGE_ATTRIBUTES_JSON = JSON.stringify({ region: "region-b" });
  resetDbInstance();
  assert.equal(aggregateUsageSink(sink), 1);
  const [delivery] = listUsageDeliveries(sink.id);
  const event = delivery.payload.event as Record<string, unknown>;
  assert.deepEqual(event.attributes, {
    project_id: "project-a",
    resource_id: "resource-a",
    region: "region-a",
  });
  assert.equal(event.tenantId, "tenant-a");
  assert.equal(event.pricingKnown, false);
  assert.deepEqual(event.tokens, {
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 15,
    cacheCreationTokens: 5,
    reasoningTokens: 3,
  });
  assert.equal(JSON.stringify(delivery.payload).includes(key.key), false);
  assert.ok(event.eventId);
  const count = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE request_id = ?")
    .get("request-a") as { n: number };
  assert.equal(count.n, 1);
});

test("window reporting separates historical tenant/attribute bindings of the same key", () => {
  const sink = createUsageSink({
    name: "Window",
    url: "https://example.test/report",
    secretEncrypted: "fixture",
    mode: "window",
    windowSec: 300,
    enabled: true,
  });
  const open = new Date("2026-10-13T10:00:00Z");
  aggregateUsageSink(sink, open);
  recordLedgerEntries(
    ["tenant-a", "tenant-b"].map((tenantId) => ({
      apiKeyId: "shared-key",
      tenantId,
      usageAttributes: { project_id: tenantId },
      provider: "example",
      model: "sample",
      tokensInput: 10,
      tokensCacheRead: 4,
      tokensCacheCreation: 2,
      amountUsd: 0.01,
    }))
  );
  const active = getUsageSink(sink.id);
  assert.equal(aggregateUsageSink(active, new Date("2026-10-13T10:05:00Z")), 1);
  const groups = listUsageDeliveries(sink.id)[0].payload.keys as Array<Record<string, unknown>>;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.tenantId).sort(), ["tenant-a", "tenant-b"]);
});

test("zero-price streaming is opt-in and pricing failures still emit measured token usage", async () => {
  delete process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS;
  const records: Array<{ cost: number; details: unknown }> = [];
  const input = {
    apiKeyId: "key-a",
    provider: "example",
    model: "sample",
    streamUsage: { prompt_tokens: 100, completion_tokens: 25 },
    recordCost: (_key: string, cost: number, details: unknown) => records.push({ cost, details }),
    calculateCost: async () => 0,
  };
  recordStreamingCost(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.length, 0);
  process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS = "true";
  recordStreamingCost(input);
  recordStreamingCost({
    ...input,
    calculateCost: async () => {
      throw new Error("Pricing unavailable");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    records.map((r) => r.cost),
    [0, 0]
  );
  assert.ok(records.every((r) => (r.details as { tokens: unknown }).tokens === input.streamUsage));
});
