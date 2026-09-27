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
import {
  canEvaluateJevModel,
  parseJevRoutingConfig,
  restrictJevConnections,
} from "../../open-sse/services/combo/jevConfig.ts";
import {
  classifyJevRoutingTier,
  createJevToolDecision,
  decideJevTool,
  hasUsableDecisionConnection,
  isDecisionConnectionAllowed,
  jevTierToMinimum,
  readJevTier,
} from "../../src/sse/services/jevRouting.ts";
import { applyToolDecision } from "../../open-sse/handlers/chatCore/toolDecision.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { readSystemOneJson } from "../../src/sse/handlers/systemOne.ts";
import { comboRuntimeConfigSchema } from "../../src/shared/validation/schemas/combo.ts";

test("JEV routing remains off unless explicitly configured", () => {
  assert.deepEqual(parseJevRoutingConfig({ config: {} }), {
    mode: "off",
    model: "typesafe-ai/jev-latest",
    toolMode: "off",
  });
  assert.deepEqual(
    parseJevRoutingConfig({
      config: { auto: { decision: { mode: "jev", model: "opencode-zen/jev-1.13-free" } } },
    }),
    { mode: "jev", model: "opencode-zen/jev-1.13-free", toolMode: "off" }
  );
  assert.equal(
    parseJevRoutingConfig({ autoConfig: { decision: { mode: "unknown" } } }).mode,
    "off"
  );
  assert.equal(
    parseJevRoutingConfig({ config: { decision: { mode: "jev", toolMode: "hint" } } }).toolMode,
    "hint"
  );
});

test("combo writes bound the decision model and reject unsupported JEV modes", () => {
  assert.equal(
    comboRuntimeConfigSchema.safeParse({
      auto: { decision: { mode: "jev", model: "typesafe-ai/jev-latest" } },
    }).success,
    true
  );
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ decision: { mode: "automatic" } }).success,
    false
  );
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ decision: { mode: "jev", model: "" } }).success,
    false
  );
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ decision: { mode: "jev", toolMode: "unsafe" } }).success,
    false
  );
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ decision: { mode: "jev", model: "x".repeat(201) } })
      .success,
    false
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

test("JEV respects the caller's connection allowlist before making an auxiliary call", () => {
  assert.equal(isDecisionConnectionAllowed("decision-1", null), true);
  assert.equal(isDecisionConnectionAllowed("decision-1", []), false);
  assert.equal(isDecisionConnectionAllowed("decision-1", ["decision-1"]), true);
  assert.equal(isDecisionConnectionAllowed("decision-1", ["chat-only"]), false);
  assert.deepEqual(restrictJevConnections(null, ["decision-1"]), ["decision-1"]);
  assert.deepEqual(restrictJevConnections(["chat-only"], ["decision-1"]), []);
  assert.deepEqual(restrictJevConnections(["decision-1"], []), []);
  assert.equal(restrictJevConnections(null, null), null);
});

test("JEV abstains before credential lookup when the caller has no eligible connection", async () => {
  const log = { info() {}, warn() {} };
  const result = await classifyJevRoutingTier(
    { messages: [{ role: "user", content: "hello" }] },
    { mode: "jev", model: "typesafe-ai/jev-latest", toolMode: "off" },
    log,
    { allowedConnections: [], apiKeyId: "request-key" }
  );
  assert.equal(result, null);
});

test("JEV tool decision stays opt-in and preserves explicit client choices", async () => {
  const log = { info() {}, warn() {} };
  const config = {
    mode: "jev" as const,
    model: "typesafe-ai/jev-latest",
    toolMode: "forced" as const,
  };
  assert.equal(createJevToolDecision(config, false, log), null);
  assert.equal(createJevToolDecision({ ...config, toolMode: "off" }, true, log), null);
  const pinned = {
    messages: [{ role: "user", content: "Use the search tool" }],
    tools: [{ type: "function", function: { name: "search" } }],
    tool_choice: "none",
  };
  assert.equal(
    await decideJevTool(pinned, FORMATS.OPENAI, "openai", config, log, {
      allowedConnections: [],
    }),
    null
  );
  assert.equal(pinned.tool_choice, "none");
});

test("JEV chat callback abstains without eligible connections and runs only once", async () => {
  const log = { info() {}, warn() {} };
  const callback = createJevToolDecision(
    { mode: "jev", model: "typesafe-ai/jev-latest", toolMode: "forced" },
    true,
    log,
    { allowedConnections: [] }
  );
  assert.ok(callback);
  const body = {
    messages: [{ role: "user", content: "Search" }],
    tools: [{ type: "function", function: { name: "search" } }],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const applied = await applyToolDecision(body, {
      decideTool: callback,
      format: FORMATS.OPENAI,
      provider: "openai",
      model: "test-model",
    });
    assert.equal(applied.toolDecision, null);
    assert.equal(applied.logLine, null);
  }
  assert.equal("tool_choice" in body, false);
});

test("JEV model policy abstains on denial or lookup failure", async () => {
  const config = { mode: "jev" as const, model: "typesafe-ai/jev-latest" };
  assert.equal(await canEvaluateJevModel(config, ["decision-1"], async () => true), true);
  assert.equal(await canEvaluateJevModel(config, ["decision-1"], async () => false), false);
  assert.equal(
    await canEvaluateJevModel(config, ["decision-1"], async () => {
      throw new Error("policy unavailable");
    }),
    false
  );
  assert.equal(
    await canEvaluateJevModel(config, [], async () => {
      throw new Error("must not query policy");
    }),
    false
  );
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
