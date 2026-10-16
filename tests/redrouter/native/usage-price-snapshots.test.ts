import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "redrouter-price-snapshot-"));
process.env.DATA_DIR = directory;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updatePricing } = await import("../../../src/lib/db/settings/pricing.ts");
const { recordLedgerFromCost } = await import("../../../src/lib/usage/costLedgerRecorder.ts");
const { recordLedgerEntry, listLedgerEntries } = await import("../../../src/lib/db/costLedger.ts");
const { createUsageSink, listUsageDeliveries } = await import("../../../src/lib/db/usageSinks.ts");
const { aggregateUsageSink } = await import("../../../src/lib/usageSinks/engine.ts");
const { snapshotModelPricing } = await import("../../../src/lib/usage/pricingSnapshot.ts");
const { windowPayload } = await import("../../../src/lib/usageSinks/payloads.ts");
const { listCostedUsageAfter } = await import("../../../src/lib/db/usageSinks.ts");

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("all token prices survive recording, a price change, restart and sink delivery", async () => {
  await updatePricing({ fixture: { sample: { input: 2, output: 8, cached: 0.2, cache_creation: 3, reasoning: 10 } } });
  const sink = createUsageSink({ name: "Prices", url: "https://example.test/report", secretEncrypted: "fixture", mode: "instant", enabled: true });
  await recordLedgerFromCost({ apiKeyId: "key-price", provider: "fixture", model: "sample", requestId: "price-request",
    tokens: { input: 1000, output: 100, cacheRead: 200, cacheCreation: 100, reasoning: 10 }, amountUsd: 0.00256 });
  const original = listLedgerEntries("key-price")[0].pricingSnapshot;
  assert.deepEqual(original, { currency: "USD", unit: "million-tokens", source: "router-model-pricing", capturedAt: original?.capturedAt,
    input: 2, output: 8, cacheRead: 0.2, cacheWrite: 3, reasoning: 10, serviceTierMultiplier: 1 });
  await updatePricing({ fixture: { sample: { input: 200, output: 800, cached: 20, cache_creation: 300 } } });
  resetDbInstance();
  assert.equal(aggregateUsageSink(sink), 1);
  const event = listUsageDeliveries(sink.id)[0].payload.event as Record<string, unknown>;
  assert.deepEqual(event.pricing, original);
  assert.deepEqual(event.tokens, { promptTokens: 1000, completionTokens: 100, cachedTokens: 200, cacheCreationTokens: 100, reasoningTokens: 10 });
  assert.equal(event.cost, 0.00256);
  assert.equal(aggregateUsageSink(sink), 0);
});

test("missing historical prices stay null and zero-priced cache remains zero", () => {
  recordLedgerEntry({ apiKeyId: "key-old", provider: "fixture", model: "old", amountUsd: 0.01 });
  const row = listCostedUsageAfter(0, 100).find(row => row.apiKeyId === "key-old");
  assert.equal(row?.pricingSnapshot, null);
  const snapshot = snapshotModelPricing({ input: 2, output: 8, cached: 0 }, "2026-10-16T00:00:00Z");
  assert.equal(snapshot.cacheRead, 0);
  assert.equal(snapshot.cacheWrite, 2);
  assert.equal(snapshot.reasoning, 8);
});

test("window reports preserve separate model rates instead of collapsing price changes", () => {
  const sink = createUsageSink({ name: "Window prices", url: "https://example.test/report", secretEncrypted: "fixture", mode: "window", windowSec: 300, enabled: true });
  const row = listCostedUsageAfter(0, 100).find(row => row.apiKeyId === "key-price")!;
  const second = { ...row, pricingSnapshot: { ...row.pricingSnapshot!, input: 5 } };
  const report = windowPayload(sink, [row, second], "window-id", { fromId: 1, toId: 2 }, "2026-10-16T00:00:00Z", "2026-10-16T00:05:00Z");
  assert.equal(report.keys[0].byModel.length, 2);
  assert.deepEqual(report.keys[0].byModel.map(model => model.pricing?.input), [2, 5]);
});
