import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install: repository, engine and soft alert of the reusable budgets.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-budgets-engine-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budgets-engine-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const repo = await import("../../../src/lib/db/budgets.ts");
const groups = await import("../../../src/lib/db/apiKeyGroups.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");

const METERED = "openai";
const FLAT_RATE = "opencode-go";
const DAY = 24 * 60 * 60 * 1000;
// A fixed instant mid-day (UTC) so daily windows are predictable.
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

after(() => {
  engine.setBudgetWarningNotifier(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDbInstance();
  db.prepare("DELETE FROM budget_windows").run();
  db.prepare("DELETE FROM budget_assignments").run();
  db.prepare("DELETE FROM budgets").run();
  db.prepare("DELETE FROM key_group_members").run();
  db.prepare("DELETE FROM key_groups").run();
  engine.setBudgetWarningNotifier(null);
  engine.resetBudgetEngineCache();
});

// Group membership is a foreign key on api_keys, so members must be real keys.
async function makeKey(name: string): Promise<string> {
  return (await createApiKey(name, "budgets-test-machine")).id;
}

function makeBudget(overrides: Partial<Parameters<typeof repo.createBudget>[0]> = {}) {
  return repo.createBudget({
    name: "cap",
    maxUsd: 10,
    duration: "daily",
    onExceed: "block",
    ...overrides,
  });
}

function assignKey(budgetId: string, ...keyIds: string[]) {
  repo.replaceBudgetAssignments(
    budgetId,
    keyIds.map((scopeValue) => ({ scopeType: "key" as const, scopeValue }))
  );
}

// --- repository -------------------------------------------------------------------------------

test("budgets are created with defaults, updated in part and deleted with their data", () => {
  const created = repo.createBudget({ name: "team cap", maxUsd: 50, duration: "monthly" });
  assert.equal(created.onExceed, "block");
  assert.equal(created.throttleDelayMs, 1000);
  assert.equal(created.enabled, true);
  assert.equal(created.softUsd, null);
  assert.equal(repo.effectiveSoftUsd(created), 40, "the soft threshold defaults to 80% of max");

  const updated = repo.updateBudget(created.id, {
    softUsd: 30,
    enabled: false,
    resetTime: "06:00",
  });
  assert.equal(updated?.softUsd, 30);
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.resetTime, "06:00");
  assert.equal(updated?.maxUsd, 50, "an omitted field keeps its value");
  assert.equal(repo.updateBudget(created.id, { softUsd: null })?.softUsd, null);
  assert.equal(repo.updateBudget("missing", { name: "x" }), null);

  assignKey(created.id, "key-1");
  repo.incrementWindowSpend(created.id, "key-1", 0, 2);
  assert.equal(repo.deleteBudget(created.id), true);
  assert.equal(repo.getBudgetById(created.id), null);
  assert.deepEqual(repo.getBudgetAssignments(created.id), []);
  assert.equal(repo.getWindowSpent(created.id, "key-1", 0), 0);
  assert.equal(repo.deleteBudget(created.id), false);
});

test("replacing assignments swaps the whole set and collapses duplicates", () => {
  const budget = makeBudget();
  repo.replaceBudgetAssignments(budget.id, [
    { scopeType: "key", scopeValue: "k1" },
    { scopeType: "key", scopeValue: "k1" },
    { scopeType: "group", scopeValue: "g1" },
  ]);
  assert.deepEqual(repo.getBudgetAssignments(budget.id), [
    { scopeType: "group", scopeValue: "g1" },
    { scopeType: "key", scopeValue: "k1" },
  ]);
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "k2" }]);
  assert.deepEqual(repo.getBudgetAssignments(budget.id), [{ scopeType: "key", scopeValue: "k2" }]);
  assert.equal(repo.getAllBudgetAssignments().get(budget.id)?.length, 1);
});

test("50 concurrent increments add up exactly", async () => {
  const budget = makeBudget({ maxUsd: 1000 });
  await Promise.all(
    Array.from({ length: 50 }, async () => repo.incrementWindowSpend(budget.id, "k1", 100, 0.25))
  );
  assert.equal(repo.getWindowSpent(budget.id, "k1", 100), 12.5);
  assert.equal(repo.getBudgetWindowTotal(budget.id, 100), 12.5);
});

test("a new window starts from zero and leaves the old one as history", () => {
  const budget = makeBudget();
  repo.incrementWindowSpend(budget.id, "k1", 1000, 4);
  repo.incrementWindowSpend(budget.id, "k1", 2000, 1);
  assert.equal(repo.getWindowSpent(budget.id, "k1", 1000), 4);
  assert.equal(repo.getWindowSpent(budget.id, "k1", 2000), 1);
  assert.equal(repo.getWindowSpent(budget.id, "k1", 3000), 0);
});

test("the soft alert can be claimed exactly once per window", () => {
  const budget = makeBudget();
  repo.incrementWindowSpend(budget.id, "k1", 1000, 1);
  assert.equal(repo.claimSoftAlert(budget.id, "k1", 1000), true);
  assert.equal(repo.claimSoftAlert(budget.id, "k1", 1000), false);
  // Another window or another scope has its own flag.
  repo.incrementWindowSpend(budget.id, "k1", 2000, 1);
  repo.incrementWindowSpend(budget.id, "k2", 1000, 1);
  assert.equal(repo.claimSoftAlert(budget.id, "k1", 2000), true);
  assert.equal(repo.claimSoftAlert(budget.id, "k2", 1000), true);
  // No row, nothing to claim.
  assert.equal(repo.claimSoftAlert(budget.id, "k3", 1000), false);
});

test("the assignment map is cached and dropped by any write", () => {
  const budget = makeBudget();
  assignKey(budget.id, "k1");
  assert.equal(repo.getApplicableBudgets("k1", [], NOW).length, 1);

  // A write behind the module's back is not seen until the TTL passes...
  getDbInstance().prepare("DELETE FROM budget_assignments").run();
  assert.equal(repo.getApplicableBudgets("k1", [], NOW + 1000).length, 1);
  assert.equal(
    repo.getApplicableBudgets("k1", [], NOW + repo.BUDGET_SNAPSHOT_TTL_MS + 1).length,
    0
  );

  // ...while a write through the module is seen at once.
  assignKey(budget.id, "k1");
  assert.equal(repo.getApplicableBudgets("k1", [], NOW).length, 1);
  repo.updateBudget(budget.id, { enabled: false });
  assert.equal(
    repo.getApplicableBudgets("k1", [], NOW).length,
    0,
    "disabled budgets are not applicable"
  );
});

// --- engine -----------------------------------------------------------------------------------

test("a key under its limit is ok, at its limit is blocked with the window end", () => {
  const budget = makeBudget({ name: "Daily cap", maxUsd: 10 });
  assignKey(budget.id, "k1");
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 9.99 }, NOW);
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 0.01 }, NOW);
  const blocked = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.budgetId, budget.id);
  assert.equal(blocked.resetAt, Date.UTC(2026, 8, 16, 0, 0, 0));
  assert.match(blocked.reason ?? "", /Daily cap/);

  // Another key is untouched, and the next window is empty again.
  assert.equal(engine.checkBudgets({ keyId: "k2", provider: METERED }, NOW).state, "ok");
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + DAY).state, "ok");
});

test("a total budget never resets and reports no reset instant", () => {
  const budget = makeBudget({ duration: "total", maxUsd: 5 });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 5 }, NOW);
  const blocked = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 400 * DAY);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.resetAt, undefined);
});

test("a throttle budget delays instead of blocking, capped", () => {
  const budget = makeBudget({ onExceed: "throttle", throttleDelayMs: 2500, maxUsd: 1 });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 2 }, NOW);
  const result = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW);
  assert.deepEqual(result, { state: "throttle", delayMs: 2500, budgetId: budget.id });

  repo.updateBudget(budget.id, { throttleDelayMs: 300_000 });
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).delayMs, 300_000);
});

test("the strictest exceeded budget wins: block beats throttle beats ok", () => {
  const soft = makeBudget({ name: "slow", onExceed: "throttle", throttleDelayMs: 500, maxUsd: 1 });
  const slower = makeBudget({
    name: "slower",
    onExceed: "throttle",
    throttleDelayMs: 900,
    maxUsd: 2,
  });
  const hard = makeBudget({ name: "hard", onExceed: "block", maxUsd: 100 });
  for (const budget of [soft, slower, hard]) assignKey(budget.id, "k1");
  // assignKey replaces per budget, so all three now apply to k1.

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 3 }, NOW);
  const throttled = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW);
  assert.equal(throttled.state, "throttle", "throttle only when every exceeded budget is throttle");
  assert.equal(throttled.delayMs, 900, "the longest delay applies");

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 97 }, NOW);
  const blocked = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.budgetId, hard.id);
});

test("a group budget is one shared pool for the members of the group", async () => {
  const [alice, bob, carol] = await Promise.all([
    makeKey("alice"),
    makeKey("bob"),
    makeKey("carol"),
  ]);
  const team = groups.createKeyGroup("platform");
  assert.equal(groups.addKeyToGroup(alice, team.id), true);
  assert.equal(groups.addKeyToGroup(bob, team.id), true);
  const budget = makeBudget({ maxUsd: 10 });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "group", scopeValue: team.id }]);

  engine.recordBudgetSpend({ keyId: alice, provider: METERED, usd: 6 }, NOW);
  assert.equal(engine.checkBudgets({ keyId: bob, provider: METERED }, NOW).state, "ok");
  engine.recordBudgetSpend({ keyId: bob, provider: METERED, usd: 4 }, NOW);

  assert.equal(engine.checkBudgets({ keyId: alice, provider: METERED }, NOW).state, "blocked");
  assert.equal(engine.checkBudgets({ keyId: bob, provider: METERED }, NOW).state, "blocked");
  assert.equal(
    repo.getWindowSpent(budget.id, team.id, engine.computeBudgetWindow(budget, NOW).windowStart),
    10
  );
  // Someone outside the group is not governed by it.
  assert.equal(engine.checkBudgets({ keyId: carol, provider: METERED }, NOW).state, "ok");
});

test("a key and its group each count against their own assignment", async () => {
  const dave = await makeKey("dave");
  const team = groups.createKeyGroup("ops");
  assert.equal(groups.addKeyToGroup(dave, team.id), true);
  const budget = makeBudget({ maxUsd: 10 });
  repo.replaceBudgetAssignments(budget.id, [
    { scopeType: "group", scopeValue: team.id },
    { scopeType: "key", scopeValue: dave },
  ]);
  engine.recordBudgetSpend({ keyId: dave, provider: METERED, usd: 3 }, NOW);
  const windowStart = engine.computeBudgetWindow(budget, NOW).windowStart;
  assert.equal(repo.getWindowSpent(budget.id, team.id, windowStart), 3);
  assert.equal(repo.getWindowSpent(budget.id, dave, windowStart), 3);
});

test("flat-rate providers are neither charged nor refused", () => {
  const budget = makeBudget({ maxUsd: 1 });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: FLAT_RATE, usd: 50 }, NOW);
  assert.equal(
    repo.getBudgetWindowTotal(budget.id, engine.computeBudgetWindow(budget, NOW).windowStart),
    0
  );

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 50 }, NOW);
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "blocked");
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: FLAT_RATE }, NOW).state, "ok");
});

test("a disabled budget is ignored", () => {
  const budget = makeBudget({ maxUsd: 1, enabled: false });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 5 }, NOW);
  assert.equal(
    repo.getBudgetWindowTotal(budget.id, engine.computeBudgetWindow(budget, NOW).windowStart),
    0
  );
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");
});

test("bad spend amounts and missing keys record nothing", () => {
  const budget = makeBudget();
  assignKey(budget.id, "k1");
  const windowStart = engine.computeBudgetWindow(budget, NOW).windowStart;
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: -3 }, NOW);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: Number.NaN }, NOW);
  engine.recordBudgetSpend({ keyId: null, provider: METERED, usd: 3 }, NOW);
  assert.equal(repo.getBudgetWindowTotal(budget.id, windowStart), 0);
  assert.equal(engine.checkBudgets({ keyId: undefined, provider: METERED }, NOW).state, "ok");
});

test("with no assignments the hot path issues no database query", () => {
  makeBudget(); // exists, assigned to nothing
  engine.resetBudgetEngineCache();
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok"); // loads the map

  const db = getDbInstance() as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare.bind(db);
  let queries = 0;
  db.prepare = (sql: string) => {
    queries += 1;
    return original(sql);
  };
  try {
    for (let i = 0; i < 100; i++) {
      engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + i);
      engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 1 }, NOW + i);
    }
  } finally {
    db.prepare = original;
  }
  assert.equal(queries, 0);
});

// --- soft alert -------------------------------------------------------------------------------

test("the soft alert fires once per window with ids and amounts only", () => {
  const budget = makeBudget({ name: "Soft cap", maxUsd: 10, softUsd: 8 });
  assignKey(budget.id, "k1");
  const events: Record<string, unknown>[] = [];
  engine.setBudgetWarningNotifier((data) => events.push(data));

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 7 }, NOW);
  assert.equal(events.length, 0);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 1.5 }, NOW);
  assert.equal(events.length, 1);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 1 }, NOW);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 1 }, NOW);
  assert.equal(events.length, 1, "no repeat inside the same window");

  const [event] = events;
  assert.deepEqual(Object.keys(event).sort(), [
    "budgetId",
    "budgetName",
    "duration",
    "maxUsd",
    "resetAt",
    "scopeType",
    "scopeValue",
    "softUsd",
    "spentUsd",
    "windowStart",
  ]);
  assert.equal(event.budgetId, budget.id);
  assert.equal(event.softUsd, 8);
  assert.equal(event.spentUsd, 8.5);
  assert.equal(event.windowStart, "2026-09-15T00:00:00.000Z");

  // The next window alerts again.
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 9 }, NOW + DAY);
  assert.equal(events.length, 2);
});

test("with no explicit soft value the alert fires at 80% of the limit", () => {
  const budget = makeBudget({ maxUsd: 10 });
  assignKey(budget.id, "k1");
  const events: Record<string, unknown>[] = [];
  engine.setBudgetWarningNotifier((data) => events.push(data));
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 7.9 }, NOW);
  assert.equal(events.length, 0);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 0.1 }, NOW);
  assert.equal(events.length, 1);
});

test("the alert flag survives a restart of the in-memory state", () => {
  const budget = makeBudget({ maxUsd: 10, softUsd: 1 });
  assignKey(budget.id, "k1");
  const events: Record<string, unknown>[] = [];
  engine.setBudgetWarningNotifier((data) => events.push(data));
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 2 }, NOW);
  engine.resetBudgetEngineCache(); // what a process restart does to the caches
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 2 }, NOW);
  assert.equal(events.length, 1);
});

// --- unavailable policy (drops a table, keep last) -----------------------------------------------------

test("an unreadable budget table refuses admission without replaying completed usage", () => {
  const budget = makeBudget({ maxUsd: 1 });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 5 }, NOW);
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "blocked");

  getDbInstance().prepare("DROP TABLE budget_windows").run();
  engine.resetBudgetEngineCache();
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "blocked");
  assert.doesNotThrow(() =>
    engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 5 }, NOW)
  );

  getDbInstance().prepare("DROP TABLE budget_assignments").run();
  engine.resetBudgetEngineCache();
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "blocked");
});
