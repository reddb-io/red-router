import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskDir = mkdtempSync(join(tmpdir(), "redrouter-usage-sinks-"));
process.env.DATA_DIR = taskDir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { recordLedgerEntry } = await import("../../../src/lib/db/costLedger.ts");
const {
  createUsageSink,
  listUsageDeliveries,
  getUsageSink,
  claimUsageDelivery,
  finishUsageDelivery,
  commitUsageBatch,
} = await import("../../../src/lib/db/usageSinks.ts");
const { aggregateUsageSink, signUsageWebhook } =
  await import("../../../src/lib/usageSinks/engine.ts");

after(() => {
  resetDbInstance();
  rmSync(taskDir, { recursive: true, force: true });
});

test("instant sink persists one deterministic costed event and advances its cursor atomically", () => {
  const sink = createUsageSink({
    name: "Billing callback",
    url: "https://example.test/usage",
    secretEncrypted: "fixture-secret",
    mode: "instant",
    enabled: true,
  });
  recordLedgerEntry({
    apiKeyId: "key-a",
    provider: "openai",
    model: "sample",
    tokensInput: 100,
    tokensOutput: 20,
    amountUsd: 0.05,
    timestamp: "2026-09-28T10:00:00.000Z",
    requestId: "req-1",
  });
  assert.equal(aggregateUsageSink(sink), 1);
  const [delivery] = listUsageDeliveries(sink.id);
  assert.match(delivery.id, /^ue_[0-9a-f]{24}$/);
  assert.equal(delivery.payload.type, "usage.recorded");
  assert.equal(delivery.payload.source, "request_cost_ledger");
  assert.equal((delivery.payload.event as Record<string, unknown>).cost, 0.05);
  assert.equal(aggregateUsageSink(getUsageSink(sink.id)!), 0);
  assert.equal(listUsageDeliveries(sink.id).length, 1);

  resetDbInstance();
  assert.equal(listUsageDeliveries(sink.id)[0].id, delivery.id);
  assert.equal(
    commitUsageBatch(sink.id, sink.cursorId, getUsageSink(sink.id)!.cursorId, []),
    false
  );
});

test("delivery lease prevents a second worker claiming the same event", () => {
  const sink = getDbInstance().prepare("SELECT id FROM redrouter_usage_sinks LIMIT 1").get() as {
    id: string;
  };
  const [delivery] = listUsageDeliveries(sink.id);
  const now = "2100-01-01T00:00:00.000Z";
  const leaseUntil = "2100-01-01T00:00:30.000Z";
  assert.equal(claimUsageDelivery(delivery.id, now, leaseUntil), true);
  assert.equal(claimUsageDelivery(delivery.id, now, leaseUntil), false);
  finishUsageDelivery(delivery.id, {
    status: "delivered",
    nextAttemptAt: null,
    httpStatus: 200,
    error: null,
    deliveredAt: now,
  });
  assert.equal(listUsageDeliveries(sink.id)[0].status, "delivered");
});

test("window sink groups priced ledger rows per key and model", () => {
  const sink = createUsageSink({
    name: "Window callback",
    url: "https://example.test/usage",
    secretEncrypted: "fixture-secret",
    mode: "window",
    windowSec: 300,
    enabled: true,
  });
  const before = new Date("2026-09-28T10:00:00.000Z");
  assert.equal(aggregateUsageSink(sink, before), 0);
  recordLedgerEntry({
    apiKeyId: "key-b",
    provider: "anthropic",
    model: "sample",
    tokensInput: 20,
    tokensOutput: 10,
    amountUsd: 0.02,
  });
  assert.equal(aggregateUsageSink(getUsageSink(sink.id)!, new Date("2026-09-28T10:05:00.000Z")), 1);
  const [delivery] = listUsageDeliveries(sink.id);
  assert.equal(delivery.payload.type, "usage.window");
  assert.equal((delivery.payload.keys as Array<Record<string, unknown>>).length, 1);
  assert.equal(
    (delivery.payload.keys as Array<Record<string, unknown>>)[0].totals &&
      (
        (delivery.payload.keys as Array<Record<string, unknown>>)[0].totals as Record<
          string,
          unknown
        >
      ).cost,
    0.02
  );
});

test("Standard Webhooks signature is stable for the same body and timestamp", () => {
  const a = signUsageWebhook("ue_123", "12345", "{}", "secret");
  assert.equal(a, signUsageWebhook("ue_123", "12345", "{}", "secret"));
  assert.match(a, /^v1,[A-Za-z0-9+/]+=*$/);
  assert.notEqual(a, signUsageWebhook("ue_123", "12346", "{}", "secret"));
});
