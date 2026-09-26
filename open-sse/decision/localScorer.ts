// A deterministic stand-in for jev's `needs_reasoning`: how much deliberation a
// turn needs, 0..1, from the signals already extracted for routing. It is used
// when jev cannot answer (no reply, timeout, open breaker) and, in the smart
// combo's `heuristic_first`/`hybrid` modes, to skip the call when the answer is
// obvious. Coarse on purpose: it only has to beat "keep whatever was there".
//
// Ported 1:1 from the legacy fork (open-sse/decision/localScorer.js @ c66f917c).

import { JEV_TIERS } from "../config/jev.ts";

const HARD_WORDS =
  /\b(why|design|architect\w*|debug\w*|investigat\w*|refactor\w*|prove|proof|optimi[sz]\w*|concurren\w*|race condition|deadlock|trade-?offs?|root cause|algorithm\w*|migrat\w*|security|vulnerab\w*|performance|analy[sz]\w*|por ?que|arquitetura|investig\w*|otimiz\w*)\b/i;
const EASY_WORDS =
  /\b(rename|typo|format\w*|reformat|list|show|print|translate|traduz\w*|lint|bump|update the version|add a comment|spell\w*|capitali[sz]e)\b/i;
const CODE_PATTERN = /```|\bfunction\b|=>|\bclass\s+\w+|\bdef\s+\w+\(|\bimport\s+[\w{]/;

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * @param signals extractSignals() output
 * @returns {{ score: number, reasons: string[] }}
 */
export function localDeliberation(signals: Record<string, unknown> = {}): {
  score: number;
  reasons: string[];
} {
  if (signals.housekeeping) return { score: 0, reasons: ["housekeeping"] };
  const reasons: string[] = [];
  let score = 0.3;
  const add = (delta: number, reason: string) => {
    score += delta;
    reasons.push(reason);
  };

  const text = typeof signals.humanText === "string" ? signals.humanText : "";
  if (signals.explicitThink) add(0.35, "explicit_think");
  if (signals.planMode) add(0.25, "plan_mode");
  if (signals.stall) add(0.2, "stall");
  if (signals.lastToolError) add(0.1, "tool_error");
  if (signals.userFeedback === "rejects" || signals.userFeedback === "corrects")
    add(0.1, "feedback");
  if (typeof signals.frustration === "number" && signals.frustration > 0)
    add(0.2 * signals.frustration, "frustration");
  if (HARD_WORDS.test(text)) add(0.15, "hard_words");
  if (EASY_WORDS.test(text)) add(-0.15, "easy_words");
  if (CODE_PATTERN.test(text)) add(0.05, "code");
  if (text.length > 1500) add(0.1, "long_ask");
  else if (text.length > 0 && text.length < 60) add(-0.1, "short_ask");
  if (Number(signals.contextTokens) > 60_000) add(0.1, "large_context");
  if (signals.turnKind === "tool_continuation") add(-0.05, "tool_continuation");

  return { score: Number(clamp(score).toFixed(3)), reasons };
}

// Tier edges on the same 0..1 axis. SIMPLE < 0.25 <= MEDIUM < 0.5 <= COMPLEX < 0.75 <= REASONING.
const TIER_EDGES = [0.25, 0.5, 0.75];

/** The smart-combo tier a local score falls in. */
export function tierForScore(score: number): string {
  const index = TIER_EDGES.filter((edge) => score >= edge).length;
  return JEV_TIERS[Math.min(index, JEV_TIERS.length - 1)];
}

/** How far the score sits from the nearest tier edge: small = ambiguous, ask jev. */
export function tierMargin(score: number): number {
  return Math.min(...TIER_EDGES.map((edge) => Math.abs(score - edge)));
}
