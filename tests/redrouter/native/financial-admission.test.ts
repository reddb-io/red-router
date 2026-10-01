import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-financial-admission-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const budgets = await import("../../../src/lib/db/budgets.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");
const policy = await import("../../../src/lib/usage/meteredBudgetPolicy.ts");
const holds = await import("../../../src/lib/db/budgetReservations.ts");
const admission = await import("../../../src/lib/usage/financialAdmission.ts");
const { updatePricing } = await import("../../../src/lib/db/settings/pricing.ts");
const db = getDbInstance();
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec(
    "DELETE FROM budget_inflight_scopes; DELETE FROM budget_inflight; DELETE FROM budget_assignments; DELETE FROM budget_windows; DELETE FROM api_key_quota_counters; DELETE FROM budgets;"
  );
  engine.resetBudgetEngineCache();
});

test("concurrent estimated admissions cannot spend the same remaining allowance", async () => {
  const budget = budgets.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  budgets.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key" }]);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      policy.rejectIfMeteredBudgetExceeded("key", "openai", "fixture", {
        id: `call-${n}`,
        usd: 0.3,
      })
    )
  );
  assert.equal(results.filter((r) => r === null).length, 3);
  assert.ok(results.filter(Boolean).every((r) => r?.status === 429));
  assert.ok(Math.abs(holds.getReservedKeyCost("key") - 0.9) < 1e-9);
  holds.releaseBudgetCost("call-0");
  assert.equal(
    await policy.rejectIfMeteredBudgetExceeded("key", "openai", "fixture", {
      id: "replacement",
      usd: 0.3,
    }),
    null
  );
});

test("a stream keeps its reservation until completion or cancellation", async () => {
  await updatePricing({ openai: { "budget-fixture": { input: 1, output: 1 } } });
  const budget = budgets.createBudget({ name: "stream", maxUsd: 1, duration: "daily" });
  budgets.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "stream-key" }]);
  let cancelled = false;
  const response = await admission.withFinancialRequest(
    "stream-key",
    "openai",
    "budget-fixture",
    { max_tokens: 10 },
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
  );
  assert.ok(holds.getReservedKeyCost("stream-key") > 0);
  await response.body!.cancel();
  assert.equal(cancelled, true);
  assert.equal(holds.getReservedKeyCost("stream-key"), 0);
});

test("a budgeted unpriced model is refused before contacting its provider", async () => {
  const budget = budgets.createBudget({ name: "unpriced", maxUsd: 1, duration: "daily" });
  budgets.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "unpriced-key" }]);
  const response = await admission.withFinancialRequest(
    "unpriced-key",
    "unknown-provider",
    "unknown-model",
    {},
    async () => {
      throw new Error("must never dispatch");
    }
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "BUDGET_PRICE_UNAVAILABLE");
});
