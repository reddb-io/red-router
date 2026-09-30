import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install: tokens/requests per minute, per-model caps and the tag /
// end-user scopes of the reusable budgets (slice 2).
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-budgets-rate-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budgets-rate-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const repo = await import("../../../src/lib/db/budgets.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");
const policy = await import("../../../src/lib/usage/meteredBudgetPolicy.ts");
const costRules = await import("../../../src/domain/costRules.ts");
const { recordNonStreamingUsageStats } =
  await import("../../../open-sse/handlers/chatCore/nonStreamingUsageStats.ts");
const { recordStreamingUsageStats } =
  await import("../../../open-sse/handlers/chatCore/streamingUsageStats.ts");

const METERED = "openai";
const FLAT_RATE = "opencode-go";
const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;
// A minute-aligned instant mid-day (UTC): bucket arithmetic is exact.
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

after(() => {
  engine.setBudgetWarningNotifier(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDbInstance();
  db.prepare("DELETE FROM budget_windows").run();
  db.prepare("DELETE FROM budget_window_models").run();
  db.prepare("DELETE FROM api_key_quota_counters").run();
  db.prepare("DELETE FROM budget_assignments").run();
  db.prepare("DELETE FROM budgets").run();
  engine.setBudgetWarningNotifier(null);
  engine.resetBudgetEngineCache();
});

function makeBudget(overrides: Partial<Parameters<typeof repo.createBudget>[0]> = {}) {
  return repo.createBudget({
    name: "cap",
    maxUsd: 1000,
    duration: "daily",
    onExceed: "block",
    ...overrides,
  });
}

function assign(
  budgetId: string,
  ...scopes: Array<{ scopeType: "key" | "group" | "tag" | "user"; scopeValue: string }>
) {
  repo.replaceBudgetAssignments(budgetId, scopes);
}

const assignKey = (budgetId: string, keyId: string) =>
  assign(budgetId, { scopeType: "key", scopeValue: keyId });

// --- tokens per minute ------------------------------------------------------------------------

test("a tokens-per-minute limit blocks once the minute's tokens reach it, and clears as it rolls over", () => {
  const budget = makeBudget({ name: "TPM cap", tpmLimit: 1000 });
  assignKey(budget.id, "k1");

  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: 999 }, NOW);
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");

  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: 1 }, NOW + 5_000);
  const blocked = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 10_000);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.budgetId, budget.id);
  assert.equal(blocked.resetAt, NOW + MINUTE, "retry at the next minute bucket");
  assert.match(blocked.reason ?? "", /TPM cap.*rate limit.*1000 of 1000 tokens per minute/);

  // The 2-bucket sliding window decays: the last minute's weight fades over the next one.
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + MINUTE).state,
    "blocked"
  );
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 90_000).state, "ok");
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 2 * MINUTE).state,
    "ok"
  );
  // Another key has its own counter.
  assert.equal(engine.checkBudgets({ keyId: "k2", provider: METERED }, NOW).state, "ok");
});

test("a tokens-per-minute throttle waits for the minute to roll over instead of blocking", () => {
  const budget = makeBudget({
    tpmLimit: 100,
    onExceed: "throttle",
    throttleDelayMs: 2_000,
  });
  assignKey(budget.id, "k1");
  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: 500 }, NOW);

  const throttled = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 15_000);
  assert.equal(throttled.state, "throttle");
  assert.equal(
    throttled.delayMs,
    45_000,
    "the delay is the time left in the minute, not the USD delay"
  );
  assert.equal(throttled.budgetId, budget.id);
});

test("flat-rate providers and bad token counts touch no rate counter", () => {
  const budget = makeBudget({ tpmLimit: 10, rpmLimit: 1 });
  assignKey(budget.id, "k1");
  engine.recordBudgetTokens({ keyId: "k1", provider: FLAT_RATE, tokens: 500 }, NOW);
  engine.recordBudgetAdmission({ keyId: "k1", provider: FLAT_RATE }, NOW);
  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: -5 }, NOW);
  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: Number.NaN }, NOW);
  engine.recordBudgetTokens({ keyId: null, provider: METERED, tokens: 50 }, NOW);
  assert.equal(repo.getBudgetRateUsed(budget.id, "k1", "tpm", NOW), 0);
  assert.equal(repo.getBudgetRateUsed(budget.id, "k1", "rpm", NOW), 0);
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: FLAT_RATE }, NOW).state, "ok");
});

test("the rate counters share the key-quota table under a budget owner", () => {
  const budget = makeBudget({ tpmLimit: 100 });
  assignKey(budget.id, "k1");
  engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: 7 }, NOW);
  const rows = getDbInstance()
    .prepare("SELECT api_key_id, dimension_key, consumed FROM api_key_quota_counters")
    .all() as Array<{ api_key_id: string; dimension_key: string; consumed: number }>;
  assert.deepEqual(rows, [
    { api_key_id: `budget:${budget.id}`, dimension_key: "k1:tpm", consumed: 7 },
  ]);
  repo.deleteBudget(budget.id);
  assert.equal(
    (
      getDbInstance().prepare("SELECT COUNT(*) AS n FROM api_key_quota_counters").get() as {
        n: number;
      }
    ).n,
    0,
    "deleting the budget drops its counters"
  );
});

test("50 concurrent token increments add up exactly", async () => {
  const budget = makeBudget({ tpmLimit: 100_000 });
  assignKey(budget.id, "k1");
  await Promise.all(
    Array.from({ length: 50 }, async () =>
      engine.recordBudgetTokens({ keyId: "k1", provider: METERED, tokens: 3 }, NOW)
    )
  );
  assert.equal(repo.getBudgetRateUsed(budget.id, "k1", "tpm", NOW), 150);
});

// --- requests per minute ----------------------------------------------------------------------

test("a requests-per-minute limit admits N requests then blocks until the next minute", () => {
  const budget = makeBudget({ name: "RPM cap", rpmLimit: 3 });
  assignKey(budget.id, "k1");
  for (let i = 0; i < 3; i++) {
    assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + i).state, "ok");
    engine.recordBudgetAdmission({ keyId: "k1", provider: METERED }, NOW + i);
  }
  const blocked = engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 10);
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.reason ?? "", /RPM cap.*3 of 3 requests per minute/);
  assert.equal(blocked.resetAt, NOW + MINUTE);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW + 2 * MINUTE).state,
    "ok"
  );
});

test("the gate counts admissions and answers 429 BUDGET_EXCEEDED with Retry-After when blocked", async () => {
  const budget = makeBudget({ name: "Gate RPM", rpmLimit: 2 });
  assignKey(budget.id, "key-rpm");
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("key-rpm", METERED, "openai/x"), null);
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("key-rpm", METERED, "openai/x"), null);

  const response = await policy.rejectIfMeteredBudgetExceeded("key-rpm", METERED, "openai/x");
  assert.ok(response, "the third request in the minute is refused");
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "BUDGET_EXCEEDED");
  assert.match(body.error.message, /Gate RPM/);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.doesNotMatch(JSON.stringify(body), /at \/|node_modules/);

  // A refused request is not an admission; a flat-rate provider is not counted at all.
  assert.equal(
    await policy.rejectIfMeteredBudgetExceeded("key-rpm", FLAT_RATE, "opencode-go/x"),
    null
  );
  assert.ok(repo.getBudgetRateUsed(budget.id, "key-rpm", "rpm") <= 2.0001);
});

test("a requests-per-minute throttle delays the request through the gate and lets it pass", async () => {
  const budget = makeBudget({ rpmLimit: 1, onExceed: "throttle", throttleDelayMs: 10 });
  assignKey(budget.id, "key-rpm-slow");
  assert.equal(
    await policy.rejectIfMeteredBudgetExceeded("key-rpm-slow", METERED, "openai/x"),
    null
  );
  const decision = policy.checkMeteredBudgetForProvider("key-rpm-slow", METERED, "openai/x");
  assert.equal(decision.allowed, true);
  assert.ok(decision.delayMs && decision.delayMs > 0 && decision.delayMs <= MINUTE);
  assert.ok(decision.delayMs <= engine.MAX_THROTTLE_DELAY_MS);
});

// --- the recording paths feed the counters ----------------------------------------------------

test("completed calls count tokens on both the streaming and non-streaming paths", () => {
  const budget = makeBudget({ tpmLimit: 1_000_000 });
  assignKey(budget.id, "key-usage");
  const info = { id: "key-usage", name: "usage", attribution: null };
  const usage = { prompt_tokens: 600, completion_tokens: 400 };

  recordNonStreamingUsageStats(usage, {
    traceEnabled: false,
    provider: METERED,
    connectionId: null,
    model: "gpt-4o",
    startTime: Date.now(),
    apiKeyInfo: info,
    effectiveServiceTier: "standard",
    isCombo: false,
    comboStrategy: null,
  } as unknown as Parameters<typeof recordNonStreamingUsageStats>[1]);
  recordStreamingUsageStats(usage, {
    provider: METERED,
    model: "gpt-4o",
    streamStatus: 200,
    startTime: Date.now(),
    ttft: 5,
    streamErrorCode: null,
    connectionId: null,
    apiKeyInfo: info,
    effectiveServiceTier: "standard",
    isCombo: false,
    comboStrategy: null,
  } as unknown as Parameters<typeof recordStreamingUsageStats>[1]);

  assert.equal(repo.getBudgetRateUsed(budget.id, "key-usage", "tpm"), 2000);
});

// --- per-model caps ---------------------------------------------------------------------------

test("a model cap blocks its exact model only, and the window resets it", () => {
  makeBudget(); // an unrelated budget must not interfere
  const budget = makeBudget({
    name: "Model cap",
    modelMax: { "openai/gpt-4o": 1 },
  });
  assignKey(budget.id, "k1");
  const window = engine.computeBudgetWindow(budget, NOW).windowStart;

  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o", usd: 0.6 }, NOW);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o" }, NOW).state,
    "ok"
  );
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o", usd: 0.4 }, NOW);
  // A different model on the same provider is not capped, and the total budget is far away.
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o-mini", usd: 5 }, NOW);

  const blocked = engine.checkBudgets(
    { keyId: "k1", provider: METERED, model: "openai/gpt-4o" },
    NOW
  );
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.budgetId, budget.id);
  assert.match(blocked.reason ?? "", /Model cap.*openai\/gpt-4o.*\$1\.00 of \$1\.00/);
  assert.equal(blocked.resetAt, Date.UTC(2026, 8, 16, 0, 0, 0));
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o-mini" }, NOW).state,
    "ok"
  );
  assert.equal(repo.getModelSpent(budget.id, "k1", window, "openai/gpt-4o"), 1);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o" }, NOW + DAY)
      .state,
    "ok",
    "the next window starts from zero"
  );
});

test("a provider wildcard cap counts every model of that provider", () => {
  const budget = makeBudget({ modelMax: { "anthropic/*": 2 } });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend(
    { keyId: "k1", provider: "anthropic", model: "claude-a", usd: 1.2 },
    NOW
  );
  engine.recordBudgetSpend(
    { keyId: "k1", provider: "anthropic", model: "claude-b", usd: 0.8 },
    NOW
  );
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: "anthropic", model: "anthropic/claude-c" }, NOW)
      .state,
    "blocked"
  );
  // Another provider is outside the wildcard.
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o" }, NOW).state,
    "ok"
  );
});

test("a bare model id cap matches the model whatever the provider prefix", () => {
  const budget = makeBudget({ modelMax: { "gpt-4o": 1 } });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o", usd: 1 }, NOW);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o" }, NOW).state,
    "blocked"
  );
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "gpt-4o" }, NOW).state,
    "blocked"
  );
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, model: "openai/gpt-4o-mini" }, NOW).state,
    "ok"
  );
});

test("model caps are matched case-insensitively and can be throttle-only", () => {
  const budget = makeBudget({
    modelMax: { "OpenAI/GPT-4o": 1 },
    onExceed: "throttle",
    throttleDelayMs: 700,
  });
  assignKey(budget.id, "k1");
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o", usd: 1 }, NOW);
  const result = engine.checkBudgets(
    { keyId: "k1", provider: METERED, model: "openai/gpt-4o" },
    NOW
  );
  assert.deepEqual(result, { state: "throttle", delayMs: 700, budgetId: budget.id });
});

test("model candidates are the full id, the bare id and the provider wildcard", () => {
  assert.deepEqual(engine.budgetModelCandidates("openai", "openai/gpt-4o"), [
    "openai/gpt-4o",
    "gpt-4o",
    "openai/*",
  ]);
  assert.deepEqual(engine.budgetModelCandidates("openai", "gpt-4o"), [
    "openai/gpt-4o",
    "gpt-4o",
    "openai/*",
  ]);
  assert.deepEqual(engine.budgetModelCandidates("claude", "cc/claude-x"), [
    "claude/cc/claude-x",
    "cc/claude-x",
    "claude/claude-x",
    "claude-x",
    "claude/*",
  ]);
  assert.deepEqual(engine.budgetModelCandidates(null, null), []);
});

test("50 concurrent model spends add up exactly", async () => {
  const budget = makeBudget({ modelMax: { "openai/gpt-4o": 1000 } });
  assignKey(budget.id, "k1");
  await Promise.all(
    Array.from({ length: 50 }, async () =>
      engine.recordBudgetSpend({ keyId: "k1", provider: METERED, model: "gpt-4o", usd: 0.5 }, NOW)
    )
  );
  const window = engine.computeBudgetWindow(budget, NOW).windowStart;
  assert.equal(repo.getModelSpent(budget.id, "k1", window, "openai/gpt-4o"), 25);
});

test("recordCost feeds the model caps with the resolved model", () => {
  const budget = makeBudget({ modelMax: { "openai/gpt-4o": 2 } });
  assignKey(budget.id, "key-cost");
  costRules.recordCost("key-cost", 2.5, { provider: METERED, model: "gpt-4o" });
  assert.equal(
    engine.checkBudgets({ keyId: "key-cost", provider: METERED, model: "openai/gpt-4o" }).state,
    "blocked"
  );
});

// --- tag and end-user scopes ------------------------------------------------------------------

test("a tag budget accrues spend for tagged requests only and blocks them", () => {
  const budget = makeBudget({ name: "Team A", maxUsd: 10 });
  assign(budget.id, { scopeType: "tag", scopeValue: "team-a" });

  // An untagged request, and a request with another tag, are outside the budget.
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 50 }, NOW);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 50, tags: ["team-b"] }, NOW);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, tags: ["team-a"] }, NOW).state,
    "ok"
  );

  engine.recordBudgetSpend(
    { keyId: "k1", provider: METERED, usd: 6, tags: ["team-a", "other"] },
    NOW
  );
  engine.recordBudgetSpend({ keyId: "k2", provider: METERED, usd: 4, tags: ["team-a"] }, NOW);
  // The tag is one shared pool across keys.
  const blocked = engine.checkBudgets(
    { keyId: "k3", provider: METERED, tags: ["other", "team-a"] },
    NOW
  );
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.reason ?? "", /Team A/);
  assert.equal(engine.checkBudgets({ keyId: "k3", provider: METERED }, NOW).state, "ok");
  assert.equal(
    engine.checkBudgets({ keyId: "k3", provider: METERED, tags: ["team-b"] }, NOW).state,
    "ok"
  );
});

test("an end-user budget accrues and blocks per end user", () => {
  const budget = makeBudget({ name: "Per user", maxUsd: 5 });
  assign(budget.id, { scopeType: "user", scopeValue: "alice@example.com" });

  engine.recordBudgetSpend(
    { keyId: "k1", provider: METERED, usd: 5, endUser: "alice@example.com" },
    NOW
  );
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 5, endUser: "bob" }, NOW);
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, endUser: "alice@example.com" }, NOW)
      .state,
    "blocked"
  );
  assert.equal(
    engine.checkBudgets({ keyId: "k1", provider: METERED, endUser: "bob" }, NOW).state,
    "ok"
  );
  assert.equal(engine.checkBudgets({ keyId: "k1", provider: METERED }, NOW).state, "ok");
});

test("the same value as a tag and as a user never shares a window", () => {
  const budget = makeBudget({ maxUsd: 100 });
  assign(
    budget.id,
    { scopeType: "tag", scopeValue: "acme" },
    { scopeType: "user", scopeValue: "acme" }
  );
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 3, tags: ["acme"] }, NOW);
  const window = engine.computeBudgetWindow(budget, NOW).windowStart;
  assert.equal(repo.getWindowSpent(budget.id, "tag:acme", window), 3);
  assert.equal(repo.getWindowSpent(budget.id, "user:acme", window), 0);
  engine.recordBudgetSpend({ keyId: "k1", provider: METERED, usd: 2, endUser: "acme" }, NOW);
  assert.equal(repo.getWindowSpent(budget.id, "user:acme", window), 2);
});

test("tag and user assignments are stored in the form requests are matched in", () => {
  const budget = makeBudget();
  repo.replaceBudgetAssignments(budget.id, [
    { scopeType: "tag", scopeValue: "  Team-A  " },
    { scopeType: "tag", scopeValue: "team-a" },
    { scopeType: "tag", scopeValue: "   " },
    { scopeType: "user", scopeValue: "  Alice\u0007 " },
    { scopeType: "key", scopeValue: "k1" },
  ]);
  assert.deepEqual(repo.getBudgetAssignments(budget.id), [
    { scopeType: "key", scopeValue: "k1" },
    { scopeType: "tag", scopeValue: "team-a" },
    { scopeType: "user", scopeValue: "Alice" },
  ]);
  assert.equal(repo.getAllBudgetAssignments().get(budget.id)?.length, 3);
});

test("a tag budget is only applicable to requests that carry the tag", () => {
  const budget = makeBudget();
  assign(budget.id, { scopeType: "tag", scopeValue: "x" }, { scopeType: "key", scopeValue: "k1" });
  assert.equal(repo.getApplicableBudgets("k1", [], NOW).length, 1);
  assert.equal(repo.getApplicableBudgets("k1", [], NOW, { tags: ["x"] }).length, 2);
  assert.equal(repo.getApplicableBudgets("other", [], NOW, { tags: ["x"] }).length, 1);
  assert.equal(repo.getApplicableBudgets("other", [], NOW, { tags: ["y"] }).length, 0);
  assert.equal(repo.hasBudgetAssignments(NOW), true);
});

test("the assignment table refuses an unknown scope type", () => {
  const budget = makeBudget();
  assert.throws(() =>
    getDbInstance()
      .prepare(
        "INSERT INTO budget_assignments (budget_id, scope_type, scope_value, created_at) VALUES (?, 'bogus', 'x', 'now')"
      )
      .run(budget.id)
  );
});

test("budgets keep their rate limits and model caps through updates", () => {
  const budget = makeBudget({ tpmLimit: 500, rpmLimit: 10, modelMax: { "openai/*": 3 } });
  assert.equal(budget.tpmLimit, 500);
  assert.equal(budget.rpmLimit, 10);
  assert.deepEqual(budget.modelMax, { "openai/*": 3 });
  const untouched = repo.updateBudget(budget.id, { name: "renamed" });
  assert.equal(untouched?.tpmLimit, 500);
  assert.deepEqual(untouched?.modelMax, { "openai/*": 3 });
  const cleared = repo.updateBudget(budget.id, { tpmLimit: null, rpmLimit: null, modelMax: {} });
  assert.equal(cleared?.tpmLimit, null);
  assert.equal(cleared?.rpmLimit, null);
  assert.deepEqual(cleared?.modelMax, {});
  assert.equal(makeBudget().tpmLimit, null);
});
