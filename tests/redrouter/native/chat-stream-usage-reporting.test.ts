import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const taskDir = mkdtempSync(join(tmpdir(), "redrouter-chat-stream-report-"));
process.env.DATA_DIR = taskDir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { recordCost, recordChatCallCost } = await import("../../../src/domain/costRules.ts");
const { meteredBudgetCost } = await import("../../../src/lib/usage/meteredBudgetPolicy.ts");
const { recordStreamingCost, buildStreamLedgerDetails } =
  await import("../../../open-sse/handlers/chatCore/streamingCost.ts");
const { createUsageSink, listUsageDeliveries } = await import("../../../src/lib/db/usageSinks.ts");
const { aggregateUsageSink } = await import("../../../src/lib/usageSinks/engine.ts");

// Execute the actual chatCore call expression, including its injected callback.
// A helper-only test misses guards in that callback before the durable recorder.
const source = ts.createSourceFile(
  "chatCore.ts",
  readFileSync(new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "recordStreamingCost")
    calls.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(calls.length, 1, "exercise the sole production streaming cost call site");
const expression = ts.transpileModule(calls[0].getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

after(() => {
  delete process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS;
  resetDbInstance();
  rmSync(taskDir, { recursive: true, force: true });
});

for (const scenario of [
  "unknown",
  "pricing-error",
  "priced",
  "failed-stream",
  "cost-only",
] as const) {
  test(`chatCore streaming call site preserves durable usage: ${scenario}`, async () => {
    process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS = scenario === "cost-only" ? "false" : "true";
    const key = await createApiKey(`stream ${scenario}`, "stream-report-test", [], {
      usageAttributes: { project_id: "project-a", resource_id: scenario },
    });
    const requestId = `stream-request-${scenario}`;
    const cost = scenario === "priced" ? 0.003 : 0;
    const calculateCost = async () => {
      if (scenario === "pricing-error") throw new Error("Pricing unavailable");
      return cost;
    };
    const sink = createUsageSink({
      name: `Stream ${scenario}`,
      url: "https://example.test/report",
      secretEncrypted: "fixture",
      mode: "instant",
      enabled: true,
    });
    const invoke = () =>
      runInNewContext(expression, {
        recordStreamingCost,
        recordCost,
        recordChatCallCost,
        meteredBudgetCost,
        buildStreamLedgerDetails,
        apiKeyInfo: { id: key.id, attribution: { sessionId: "session-a" } },
        provider: "unpriced-test-provider",
        model: "generation-test",
        streamUsage: {
          prompt_tokens: 40,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 8 },
        },
        effectiveServiceTier: "standard",
        normalizedStreamStatus: scenario === "failed-stream" ? 502 : 200,
        traceId: requestId,
        calculateCost,
      });
    invoke();
    invoke();
    const query = () =>
      getDbInstance()
        .prepare("SELECT * FROM request_cost_ledger WHERE request_id = ?")
        .all(requestId) as Array<Record<string, unknown>>;
    if (scenario === "cost-only") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(query().length, 0, "zero-cost reporting remains opt-in");
      return;
    }
    const deadline = Date.now() + 2000;
    while (!query().length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const rows = query();
    assert.equal(rows.length, 1, "one durable event even without a known price");
    assert.equal(rows[0].api_key_id, key.id);
    assert.equal(rows[0].tokens_input, 40);
    assert.equal(rows[0].tokens_output, 1);
    assert.equal(rows[0].tokens_cache_read, 8);
    assert.equal(rows[0].pricing_known, 0);
    assert.equal(rows[0].amount_usd, cost);
    assert.equal(rows[0].success, scenario === "failed-stream" ? 0 : 1);
    assert.equal(rows[0].session_id, "session-a");
    aggregateUsageSink(sink);
    const deliveries = listUsageDeliveries(sink.id);
    const event = deliveries
      .map((delivery) => delivery.payload.event as Record<string, unknown>)
      .find((entry) => entry.requestId === requestId);
    assert.ok(event, "the generation event reaches the export outbox");
    assert.equal(event.pricingKnown, false);
    assert.deepEqual(event.attributes, { project_id: "project-a", resource_id: scenario });
    assert.equal(JSON.stringify(deliveries).includes(key.key), false);
  });
}
