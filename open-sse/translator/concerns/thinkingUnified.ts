// Unified thinking normalization: extract client intent from a request body.
//
// Additive port from the legacy fork (open-sse/translator/concerns/thinkingUnified.js
// @ c66f917c). Only `extractThinking` (and its alias) were ported — the decision
// engine (open-sse/decision/*) reads it to learn the level the client already chose.
//
// TODO(fork-port): the rest of the legacy unified module (applyThinking,
// stripThinkingSuffix, parseSuffix, provider-native capability resolution via
// providers/capabilities.js + providers/thinkingLevels.js) is coupled to the old
// fork's provider registry and was NOT ported. Re-port those pieces only when a
// consumer needs them.

type JsonRecord = Record<string, unknown>;

export type ThinkingIntent =
  | { mode: "none" }
  | { mode: "auto" }
  | { mode: "level"; level: string }
  | { mode: "budget"; budget: number };

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// Extract unified thinking intent from a request body (post-translation, mixed shapes).
// Returns { mode, budget?, level? } or null when no thinking intent present.
export function extractThinking(body: unknown): ThinkingIntent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as JsonRecord;

  // Claude output_config.effort (explicit) — priority over adaptive thinking
  const oc = asRecord(b.output_config)?.effort;
  if (typeof oc === "string" && oc) {
    const e = oc.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // OpenAI chat / Responses shape — check effort first (zai sends both thinking object and reasoning.effort)
  const effort = b.reasoning_effort ?? asRecord(b.reasoning)?.effort ?? null;
  if (typeof effort === "string" && effort) {
    const e = effort.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Claude shape
  const t = asRecord(b.thinking);
  if (t) {
    if (t.type === "disabled") return { mode: "none" };
    if (t.type === "adaptive" || t.type === "enabled") {
      const budget = Number(t.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) return { mode: "budget", budget };
      return { mode: "auto" };
    }
  }

  // Gemini shape (top-level, generationConfig, or request envelope)
  const tc =
    asRecord(b.thinkingConfig) ||
    asRecord(asRecord(b.generationConfig)?.thinkingConfig) ||
    asRecord(asRecord(asRecord(b.request)?.generationConfig)?.thinkingConfig);
  if (tc) {
    if (typeof tc.thinkingLevel === "string")
      return { mode: "level", level: tc.thinkingLevel.toLowerCase() };
    const tb = Number(tc.thinkingBudget);
    if (Number.isFinite(tb)) {
      if (tb === 0) return { mode: "none" };
      if (tb < 0) return { mode: "auto" };
      return { mode: "budget", budget: tb };
    }
  }

  // Qwen shape
  if (b.enable_thinking === false) return { mode: "none" };
  if (b.enable_thinking === true) {
    const tb = Number(b.thinking_budget);
    if (Number.isFinite(tb) && tb > 0) return { mode: "budget", budget: tb };
    return { mode: "auto" };
  }

  return null;
}

// Capture thinking intent from a body. Alias of extractThinking, named for clarity
// at the call-site where intent is snapshotted before format translation.
export const captureThinking = extractThinking;
