// When jev cannot answer, routing falls back to a deterministic local score; the
// cost tie-break prices the whole request; a warm prompt cache raises the bar
// for switching models.
import { describe, expect, it } from "vitest";
import { localDeliberation, tierForScore, tierMargin } from "../../open-sse/decision/localScorer.js";
import { extractSignals } from "../../open-sse/decision/signals.js";
import { decideReasoningLevel, normalizeAutopilotConfig } from "../../open-sse/decision/reasoningAutopilot.js";
import { resolveModelDecision } from "../../open-sse/decision/decide.js";
import { classifyTier, resetJevBreaker } from "../../open-sse/services/jevClassifier.js";
import { decideComboModel, requestCostOf } from "../../src/sse/services/decisionRouter.js";

const ask = (text, extra = {}) => ({ messages: [{ role: "user", content: text }], ...extra });
const score = (text, extra) => localDeliberation(extractSignals(ask(text, extra))).score;

describe("localDeliberation", () => {
  it("ranks an explicit hard ask above a trivial one", () => {
    const hard = score("think hard: why does this deadlock under load? find the root cause and design a fix across the scheduler and the queue");
    const easy = score("rename foo to bar");
    expect(hard).toBeGreaterThanOrEqual(0.7);
    expect(easy).toBeLessThanOrEqual(0.2);
  });

  it("is zero for housekeeping and deterministic", () => {
    const title = { system: "You are coming up with a succinct title for a coding session.", messages: [{ role: "user", content: "x" }] };
    expect(localDeliberation(extractSignals(title)).score).toBe(0);
    expect(score("fix the bug in parser.js")).toBe(score("fix the bug in parser.js"));
  });

  it("maps scores to smart tiers and reports the margin to the nearest edge", () => {
    expect([0.1, 0.3, 0.6, 0.9].map(tierForScore)).toEqual(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);
    expect(tierMargin(0.26)).toBeCloseTo(0.01);
    expect(tierMargin(0.375)).toBeCloseTo(0.125);
  });
});

describe("reasoning autopilot fallback", () => {
  const config = normalizeAutopilotConfig({ mode: "enforce" });

  it("uses the local score on a first turn when jev failed", () => {
    const r = decideReasoningLevel({ signals: {}, deliberation: null, jevFailed: true, localDeliberation: 0.9, previous: null, config });
    expect(r).toMatchObject({ cause: "local" });
    expect(["high", "xhigh"]).toContain(r.base);
  });

  it("still keeps the session's level when there is one", () => {
    const previous = { level: "low", changedAt: 0, turn: 3, humanTurn: "old" };
    const r = decideReasoningLevel({ signals: {}, deliberation: null, jevFailed: true, localDeliberation: 0.9, turnId: "new", previous, config });
    expect(r.cause).toBe("kept");
  });
});

describe("smart classifier modes", () => {
  const failing = () => Promise.reject(Object.assign(new Error("down"), { name: "AbortError" }));

  it("falls back to the local tier when jev fails and localFallback is on", async () => {
    resetJevBreaker();
    const out = await classifyTier({ body: ask("rename foo to bar"), requestImpl: failing, localFallback: true, breakerEnabled: false });
    expect(out).toMatchObject({ source: "local", tier: "SIMPLE" });
    expect(await classifyTier({ body: ask("rename foo to bar"), requestImpl: failing, breakerEnabled: false })).toBeNull();
  });

  it("hybrid answers clear cases locally and asks jev near an edge", async () => {
    let calls = 0;
    const jev = async () => { calls++; return new Response(JSON.stringify({ answers: { tier: { choice: "COMPLEX", confidence: 0.9 } } }), { status: 200 }); };
    const clear = await classifyTier({ body: ask("rename foo to bar"), requestImpl: jev, mode: "hybrid" });
    expect(clear.source).toBe("local");
    expect(calls).toBe(0);
    // A bare ask scores 0.3 — 0.05 from the SIMPLE/MEDIUM edge — so jev is asked.
    const unclear = await classifyTier({ body: ask("update the handler so the tests pass for the new schema please"), requestImpl: jev, mode: "hybrid" });
    expect(calls).toBe(1);
    expect(unclear.source).toBe("jev");
  });

  it("heuristic_first asks jev only when no signal fired", async () => {
    let calls = 0;
    const jev = async () => { calls++; return new Response(JSON.stringify({ answers: { tier: { choice: "MEDIUM", confidence: 0.9 } } }), { status: 200 }); };
    expect((await classifyTier({ body: ask("think hard about the concurrency design"), requestImpl: jev, mode: "heuristic_first" })).source).toBe("local");
    expect(calls).toBe(0);
    await classifyTier({ body: ask("update the handler so the tests pass for the new schema please"), requestImpl: jev, mode: "heuristic_first" });
    expect(calls).toBe(1);
  });
});

describe("requestCostOf", () => {
  it("prices prompt and expected answer, with the warm member's prompt mostly cached", () => {
    const body = ask("x".repeat(40_000), { max_tokens: 64_000 });
    const cost = requestCostOf(body, { inputTokens: 10_000, warmMember: "anthropic/claude-sonnet-4-6" });
    // sonnet 4.6: $3 in, $0.30 cached, $15 out; the answer is capped at 4000 tokens.
    const cold = requestCostOf(body, { inputTokens: 10_000 })("anthropic/claude-sonnet-4-6");
    expect(cold).toBeCloseTo((10_000 * 3 + 4000 * 15) / 1e6, 8);
    expect(cost("anthropic/claude-sonnet-4-6")).toBeCloseTo((10_000 * (0.1 * 3 + 0.9 * 0.3) + 4000 * 15) / 1e6, 8);
    expect(cost("nobody/unknown-model-xyz")).toBeNull();
  });
});

describe("cache affinity", () => {
  const answers = (choice, probs) => ({ model: { type: "choice", choice, confidence: 0.7, probabilities: probs }, needs_reasoning: { type: "noul", noul: 0.5 } });
  const models = ["a/m", "b/m"];

  it("holds the warm member against a verdict that would otherwise switch", () => {
    // strength 0.4 over 2 options... use a clear-but-not-overwhelming winner.
    const probs = { "b/m": 0.84, "a/m": 0.16 }; // strength 0.68
    expect(resolveModelDecision({ answers: answers("b/m", probs), models, switchStrength: 0.6 }).apply).toBe(true);
    const held = resolveModelDecision({ answers: answers("b/m", probs), models, switchStrength: 0.6, warmMember: "a/m", cacheSwitchStrength: 0.75 });
    expect(held).toMatchObject({ apply: false, reason: "cache_affinity" });
    const staying = resolveModelDecision({ answers: answers("a/m", { "a/m": 0.84, "b/m": 0.16 }), models, switchStrength: 0.6, warmMember: "a/m", cacheSwitchStrength: 0.75 });
    expect(staying.apply).toBe(true);
  });
});

describe("decideComboModel without jev", () => {
  const pool = ["openai/gpt-4o-mini", "anthropic/claude-opus-4-6"];
  const dead = { url: "http://jev.invalid", fetchImpl: async () => { throw new Error("down"); } };
  const run = (text) => {
    const body = ask(text);
    return decideComboModel({ body, models: pool, ranked: pool, comboName: "auto", config: { model: "jev-latest", timeoutMs: 50 }, target: dead, signals: extractSignals(body) });
  };

  it("sends a clearly hard turn to the priciest member and an easy one to the cheapest", async () => {
    const hard = await run("think hard: why does this deadlock? find the root cause and design the fix");
    expect(hard.models[0]).toBe("anthropic/claude-opus-4-6");
    expect(hard.decision).toMatchObject({ apply: true, cause: "local", deliberation: null });
    const easy = await run("rename foo to bar");
    expect(easy.models[0]).toBe("openai/gpt-4o-mini");
  });

  it("leaves an unclear turn alone", async () => {
    const out = await run("update the handler so the tests pass for the new schema please");
    expect(out.decision).toBeNull();
    expect(out.reason).toBe("ask_failed");
  });
});
