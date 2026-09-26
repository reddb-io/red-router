import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WEIGHTS,
  type ProviderCandidate,
} from "../../open-sse/services/autoCombo/scoring.ts";
import { selectWithStrategy } from "../../open-sse/services/autoCombo/routerStrategy.ts";
import { selectProvider } from "../../open-sse/services/autoCombo/engine.ts";
import { setTierConfig } from "../../open-sse/services/tierResolver.ts";
import type { RoutingHint } from "../../open-sse/services/manifestAdapter.ts";
import { parseJevRoutingConfig } from "../../open-sse/services/combo/jevConfig.ts";
import {
  hasUsableDecisionConnection,
  jevTierToMinimum,
  readJevTier,
} from "../../src/sse/services/jevRouting.ts";
import { readSystemOneJson } from "../../src/sse/handlers/systemOne.ts";

test("JEV routing remains off unless explicitly configured", () => {
  assert.deepEqual(parseJevRoutingConfig({ config: {} }), {
    mode: "off",
    model: "typesafe-ai/jev-latest",
  });
  assert.deepEqual(
    parseJevRoutingConfig({
      config: { auto: { decision: { mode: "jev", model: "opencode-zen/jev-1.13-free" } } },
    }),
    { mode: "jev", model: "opencode-zen/jev-1.13-free" }
  );
  assert.equal(
    parseJevRoutingConfig({ autoConfig: { decision: { mode: "unknown" } } }).mode,
    "off"
  );
});

test("JEV requires a confident supported choice and accepts gateway probability fallback", () => {
  assert.equal(
    readJevTier({
      answers: { tier: { type: "choice", choice: "COMPLEX", probabilities: { COMPLEX: 0.8 } } },
    }),
    "COMPLEX"
  );
  assert.equal(readJevTier({ answers: { tier: { choice: "COMPLEX", confidence: 0.49 } } }), null);
  assert.equal(readJevTier({ answers: { tier: { choice: "UNKNOWN", confidence: 1 } } }), null);
  assert.equal(
    readJevTier({
      answers: { tier: { choice: "COMPLEX", probabilities: { SIMPLE: 0.8, COMPLEX: 0.2 } } },
    }),
    null
  );
  assert.equal(readJevTier({ answers: { tier: { choice: "REASONING", confidence: 1.2 } } }), null);
  assert.equal(readJevTier({ answers: {} }), null);
  assert.equal(jevTierToMinimum("SIMPLE"), "free");
  assert.equal(jevTierToMinimum("MEDIUM"), "cheap");
  assert.equal(jevTierToMinimum("REASONING"), "premium");
});

test("JEV skips terminal and throttled credential selections", () => {
  assert.equal(hasUsableDecisionConnection({ allExpired: true }), false);
  assert.equal(hasUsableDecisionConnection({ connectionId: "a", allRateLimited: true }), false);
  assert.equal(hasUsableDecisionConnection({ connectionId: "a", apiKey: "key" }), true);
});

test("score and rules strategies consume the JEV tier hint for primary selection", () => {
  setTierConfig({
    providerOverrides: [
      { provider: "jev-free-test", tier: "free" },
      { provider: "jev-premium-test", tier: "premium" },
    ],
  });
  try {
    const pool: ProviderCandidate[] = [
      {
        provider: "jev-free-test",
        model: "shared-model",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 100,
        latencyStdDev: 10,
        errorRate: 0,
      },
      {
        provider: "jev-premium-test",
        model: "shared-model",
        quotaRemaining: 100,
        quotaTotal: 100,
        circuitBreakerState: "CLOSED",
        costPer1MTokens: 1,
        p95LatencyMs: 100,
        latencyStdDev: 10,
        errorRate: 0,
      },
    ];
    const weights = Object.fromEntries(
      Object.keys(DEFAULT_WEIGHTS).map((key) => [key, key === "tierAffinity" ? 1 : 0])
    ) as typeof DEFAULT_WEIGHTS;
    for (const strategy of ["score", "rules"]) {
      const premium = selectWithStrategy(
        pool,
        {
          taskType: "general",
          weights,
          explorationRate: 0,
          manifestHint: {
            recommendedMinTier: "premium",
            specificity: { score: 80 },
          } as RoutingHint,
        },
        strategy
      );
      assert.equal(premium.provider, "jev-premium-test", strategy);
    }
  } finally {
    setTierConfig({});
  }
});

test("primary auto selection consumes the same optional tier hint as fallback ranking", () => {
  const candidate = {
    provider: "openai",
    model: "gpt-4o",
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 10,
    errorRate: 0,
  };
  const base = {
    id: "jev-test",
    name: "jev-test",
    type: "auto" as const,
    candidatePool: ["openai"],
    weights: DEFAULT_WEIGHTS,
    explorationRate: 0,
  };
  const free = selectProvider(
    { ...base, manifestHint: { recommendedMinTier: "free" } as RoutingHint },
    [candidate],
    "general"
  );
  const premium = selectProvider(
    { ...base, manifestHint: { recommendedMinTier: "premium" } as RoutingHint },
    [candidate],
    "general"
  );
  assert.notEqual(free.factors.tierAffinity, premium.factors.tierAffinity);
});

test("System One enforces its byte limit without trusting Content-Length", async () => {
  const oversized = new Request("http://localhost/v1/systemone", {
    method: "POST",
    body: JSON.stringify({ state: "x".repeat(512 * 1024) }),
  });
  await assert.rejects(readSystemOneJson(oversized), /body_too_large/);
  const valid = new Request("http://localhost/v1/systemone", {
    method: "POST",
    body: JSON.stringify({ state: "ok" }),
  });
  assert.deepEqual(await readSystemOneJson(valid), { state: "ok" });
});
