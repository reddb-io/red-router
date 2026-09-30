import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

// The combo's per-target pre-dispatch gate skips a target that is already over a blocking budget,
// without dispatching, using only what the budget engine holds in memory.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-budgets-gate-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budgets-gate-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const repo = await import("../../../src/lib/db/budgets.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");
const { withRequestAttribution } = await import("../../../src/lib/usage/attribution.ts");
const { evaluateExecuteTargetGates } =
  await import("../../../open-sse/services/combo/executeTargetGates.ts");
const trace = await import("../../../open-sse/services/combo/decisionTrace.ts");

const METERED = "openai";

after(() => {
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
  engine.resetBudgetEngineCache();
  trace.resetComboTraceStore();
});

function emptyState(): AttemptLoopState {
  return {
    orderedTargets: [],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    requestScopedFailureSeen: false,
    observeFailure() {},
  };
}

function deps(signal: AbortSignal | null, invocationId: string): AttemptLoopDeps {
  return {
    strategy: "priority",
    combo: { name: "t", models: [] },
    config: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    settings: null,
    resilienceSettings: {
      providerCooldown: { enabled: false },
    } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: invocationId,
    clientRequestedStream: false,
    handleSingleModelWithTimeout: async () => {
      throw new Error("the gate must never dispatch");
    },
    signal,
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
  };
}

function target(provider: string, model: string, index = 0): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `s${index}`,
    executionKey: `ek-${index}`,
    modelStr: `${provider}/${model}`,
    provider,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

/** A request the handler registered for `keyId`, as chat.ts does before the combo runs. */
function registerRequest(keyId: string, headers: Record<string, string> = {}) {
  const signal = new AbortController().signal;
  const request = new Request("http://localhost/v1/chat/completions", { headers });
  withRequestAttribution({ id: keyId }, request, { messages: [] }, signal);
  return signal;
}

async function gate(signal: AbortSignal | null, aTarget: ResolvedComboTarget, index = 0) {
  const invocationId = `inv-${Math.random().toString(36).slice(2)}`;
  trace.startComboTrace(invocationId, { strategy: "priority", comboName: "t" });
  const state = emptyState();
  state.orderedTargets = [aTarget, aTarget];
  const decision = await evaluateExecuteTargetGates({
    index,
    state,
    deps: deps(signal, invocationId),
  });
  return { decision, state, decisions: trace.getComboTrace(invocationId)?.decisions ?? [] };
}

test("a target over a blocking budget is skipped without dispatch and the decision is recorded", async () => {
  const budget = repo.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-gate" }]);
  const signal = registerRequest("key-gate");
  engine.recordBudgetSpend({ keyId: "key-gate", provider: METERED, usd: 2 });

  const { decision, state, decisions } = await gate(signal, target(METERED, "gpt-4o", 1), 1);
  assert.equal(decision.kind, "skip");
  assert.equal(state.fallbackCount, 1, "a skipped later target counts as a fallback");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "skipped_before_dispatch");
  assert.equal(decisions[0].reason, "budget_exhausted");
  assert.equal(decisions[0].target, "openai/gpt-4o");
});

test("a spent check marks the target exhausted even before any spend was recorded in this process", async () => {
  const budget = repo.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-gate" }]);
  const signal = registerRequest("key-gate");
  // The spend is written behind the engine's back (another process), so only a check sees it.
  repo.incrementWindowSpend(
    budget.id,
    "key-gate",
    engine.computeBudgetWindow(budget).windowStart,
    5
  );
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "proceed");

  assert.equal(engine.checkBudgets({ keyId: "key-gate", provider: METERED }).state, "blocked");
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "skip");
});

test("a cold cache does not skip: nothing is known until a check or a spend has run", async () => {
  const budget = repo.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-cold" }]);
  const signal = registerRequest("key-cold");
  engine.recordBudgetSpend({ keyId: "key-cold", provider: METERED, usd: 2 });
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "skip");

  engine.resetBudgetEngineCache(); // a restart: snapshot and exhausted map are gone
  const cold = await gate(signal, target(METERED, "gpt-4o"));
  assert.equal(cold.decision.kind, "proceed");
  assert.deepEqual(cold.decisions, []);
});

test("the gate reads memory only: no database query is issued", async () => {
  const budget = repo.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-mem" }]);
  const signal = registerRequest("key-mem");
  engine.recordBudgetSpend({ keyId: "key-mem", provider: METERED, usd: 2 });

  const db = getDbInstance() as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare.bind(db);
  let queries = 0;
  db.prepare = (sql: string) => {
    queries += 1;
    return original(sql);
  };
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal(engine.isBudgetExhaustedForTarget(signal, METERED, "openai/gpt-4o"), true);
      assert.equal(engine.isBudgetExhaustedForTarget(signal, METERED, "gpt-4o"), true);
    }
  } finally {
    db.prepare = original;
  }
  assert.equal(queries, 0);
});

test("only a blocking budget skips: throttle, flat-rate, another key and an unregistered request proceed", async () => {
  const throttle = repo.createBudget({
    name: "slow",
    maxUsd: 1,
    duration: "daily",
    onExceed: "throttle",
  });
  repo.replaceBudgetAssignments(throttle.id, [{ scopeType: "key", scopeValue: "key-slow" }]);
  engine.recordBudgetSpend({ keyId: "key-slow", provider: METERED, usd: 5 });
  engine.checkBudgets({ keyId: "key-slow", provider: METERED });
  assert.equal(
    (await gate(registerRequest("key-slow"), target(METERED, "gpt-4o"))).decision.kind,
    "proceed"
  );

  const block = repo.createBudget({ name: "hard", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(block.id, [{ scopeType: "key", scopeValue: "key-hard" }]);
  engine.recordBudgetSpend({ keyId: "key-hard", provider: METERED, usd: 5 });
  const hard = registerRequest("key-hard");
  assert.equal((await gate(hard, target(METERED, "gpt-4o"))).decision.kind, "skip");
  assert.equal(
    (await gate(hard, target("opencode-go", "x"))).decision.kind,
    "proceed",
    "flat-rate providers are not budgeted"
  );
  assert.equal(
    (await gate(registerRequest("someone-else"), target(METERED, "gpt-4o"))).decision.kind,
    "proceed"
  );
  assert.equal(
    (await gate(new AbortController().signal, target(METERED, "gpt-4o"))).decision.kind,
    "proceed"
  );
  assert.equal((await gate(null, target(METERED, "gpt-4o"))).decision.kind, "proceed");
});

test("a per-model cap skips only the capped model, a tag budget only tagged requests", async () => {
  const capped = repo.createBudget({
    name: "model cap",
    maxUsd: 100,
    duration: "daily",
    modelMax: { "openai/gpt-4o": 1 },
  });
  repo.replaceBudgetAssignments(capped.id, [{ scopeType: "key", scopeValue: "key-model" }]);
  const signal = registerRequest("key-model");
  engine.recordBudgetSpend({ keyId: "key-model", provider: METERED, model: "gpt-4o", usd: 1 });
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "skip");
  assert.equal((await gate(signal, target(METERED, "gpt-4o-mini"))).decision.kind, "proceed");

  const tagged = repo.createBudget({ name: "tag cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(tagged.id, [{ scopeType: "tag", scopeValue: "team-a" }]);
  engine.recordBudgetSpend({ keyId: "key-t", provider: METERED, usd: 3, tags: ["team-a"] });
  const withTag = registerRequest("key-t", { "x-red-router-tags": "Team-A" });
  const withoutTag = registerRequest("key-t");
  assert.equal((await gate(withTag, target(METERED, "gpt-4o"))).decision.kind, "skip");
  assert.equal((await gate(withoutTag, target(METERED, "gpt-4o"))).decision.kind, "proceed");
});

test("editing the budget lifts the skip at once", async () => {
  const budget = repo.createBudget({ name: "cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-edit" }]);
  const signal = registerRequest("key-edit");
  engine.recordBudgetSpend({ keyId: "key-edit", provider: METERED, usd: 2 });
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "skip");

  repo.updateBudget(budget.id, { maxUsd: 100 });
  assert.equal((await gate(signal, target(METERED, "gpt-4o"))).decision.kind, "proceed");
});

test("budget_exhausted is an allowlisted combo skip reason", () => {
  assert.ok((trace.COMBO_SKIP_REASONS as readonly string[]).includes("budget_exhausted"));
});
