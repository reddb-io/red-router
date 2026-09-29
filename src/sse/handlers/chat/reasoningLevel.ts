/**
 * Applying a reasoning level to the client's request body, in the client's own format, so the
 * existing reasoning pipeline (effort suffixes, thinking budgets, per-provider translation)
 * handles the rest exactly as if the client had asked for that effort itself.
 */

type JsonRecord = Record<string, unknown>;

export type ClientFormat = "openai" | "responses" | "claude";

/** The client format of a chat request, from its endpoint and body shape. */
export function clientFormatOf(pathname: string, body: JsonRecord): ClientFormat {
  if (pathname.includes("/messages")) return "claude";
  if (body.input !== undefined && body.messages === undefined) return "responses";
  return "openai";
}

const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

/**
 * Returns a copy of `body` whose effort is `level` (none, minimal, low, medium, high, xhigh,
 * max). Nothing else in the request changes.
 */
export function applyReasoningLevel(body: JsonRecord, level: string, format: ClientFormat): JsonRecord {
  const next: JsonRecord = { ...body };
  if (format === "claude") {
    if (level === "none") {
      next.thinking = { type: "disabled" };
      const output = { ...asRecord(next.output_config) };
      delete output.effort;
      if (Object.keys(output).length > 0) next.output_config = output;
      else delete next.output_config;
      return next;
    }
    const effort = CLAUDE_EFFORTS.has(level) ? level : "low";
    next.output_config = { ...asRecord(next.output_config), effort };
    return next;
  }
  if (format === "responses") {
    next.reasoning = { ...asRecord(next.reasoning), effort: level };
    return next;
  }
  next.reasoning_effort = level;
  // A nested effort would win over the flat field in some translators; keep them equal.
  if (asRecord(next.reasoning).effort !== undefined) {
    next.reasoning = { ...asRecord(next.reasoning), effort: level };
  }
  return next;
}
