// A classification the client already made, sent in HINT_HEADER so routing can use
// it instead of asking the decision model again. Pure and fail-open: anything that
// does not parse cleanly is dropped whole and routing runs exactly as without it.
//
// Grammar (case-insensitive keys and labels, whitespace around tokens ignored):
//   hint     = pair *( ";" pair ) [ ";" ]
//   pair     = key "=" value           (key: [a-z][a-z0-9_]*, at most 32 chars)
//   complexity  = unit | "simple" | "medium" | "complex" | "reasoning"
//   deliberation = unit
//   needs_tool  = "true" | "false"
//   tier        = "simple" | "medium" | "complex" | "reasoning"
//   unit     = a decimal in [0, 1] with at most 6 fraction digits: 0, 1, 0.25, .5
// The whole value is at most 512 characters.
// Unknown keys are skipped. A malformed pair, a repeated known key, an out-of-range
// value, or a hint with no known key invalidates the whole header.

import { JEV_TIERS } from "../config/jev.js";

/** The keys this build understands, in the order capabilities lists them. */
export const HINT_KEYS = ["complexity", "deliberation", "needs_tool", "tier"];

/** Recorded wherever a routing input came from the hint instead of the decision model. */
export const HINT_SOURCE = "client_hint";

const MAX_HINT_CHARS = 512;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const UNIT = /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?|\.\d{1,6})$/;
const LABELS = JEV_TIERS.map((tier) => tier.toLowerCase());

/**
 * Where a complexity label sits on the unit scale. The numeric scale is cut into
 * four equal bands, one per tier, and each label stands at its band's middle.
 */
const LABEL_COMPLEXITY = { simple: 0.125, medium: 0.375, complex: 0.625, reasoning: 0.875 };

/**
 * Parse a header value. Returns null when the header is absent or invalid;
 * `onInvalid(reason)` hears why an invalid one was dropped.
 *
 * @returns {{ complexity?: number, deliberation?: number, needsTool?: boolean, tier?: string } | null}
 */
export function parseClassificationHint(raw, { onInvalid = null } = {}) {
  if (raw === undefined || raw === null) return null;
  const invalid = (reason) => {
    try {
      onInvalid?.(reason);
    } catch {
      /* diagnostics must never break the fail-open path */
    }
    return null;
  };
  if (typeof raw !== "string") return invalid("not_a_string");
  const text = raw.trim();
  if (!text) return null;
  if (text.length > MAX_HINT_CHARS) return invalid("too_long");

  const hint = {};
  const segments = text.split(";").map((segment) => segment.trim());
  // One trailing separator is tolerated; an empty pair anywhere else is not.
  if (segments.at(-1) === "") segments.pop();
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq <= 0 || segment.indexOf("=", eq + 1) !== -1) return invalid(`malformed_pair:${segment.slice(0, 32)}`);
    const key = segment.slice(0, eq).trim().toLowerCase();
    const value = segment.slice(eq + 1).trim().toLowerCase();
    if (!KEY.test(key) || !value) return invalid(`malformed_pair:${segment.slice(0, 32)}`);
    if (!HINT_KEYS.includes(key)) continue;
    const field = key === "needs_tool" ? "needsTool" : key;
    if (field in hint) return invalid(`duplicate_key:${key}`);
    const parsed = parseValue(key, value);
    if (parsed === undefined) return invalid(`invalid_value:${key}`);
    hint[field] = parsed;
  }
  if (Object.keys(hint).length === 0) return invalid("no_known_keys");
  return hint;
}

function parseValue(key, value) {
  if (key === "needs_tool") {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (key === "tier") return LABELS.includes(value) ? value.toUpperCase() : undefined;
  if (key === "complexity" && LABELS.includes(value)) return LABEL_COMPLEXITY[value];
  if (!UNIT.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

/**
 * The smart-routing tier the hint asks for: an explicit `tier` wins, else the
 * band `complexity` falls in ([0, .25) SIMPLE, [.25, .5) MEDIUM, [.5, .75)
 * COMPLEX, [.75, 1] REASONING). Null when the hint carries neither.
 */
export function hintTier(hint) {
  if (!hint) return null;
  if (typeof hint.tier === "string" && JEV_TIERS.includes(hint.tier)) return hint.tier;
  if (typeof hint.complexity !== "number") return null;
  const index = Math.min(JEV_TIERS.length - 1, Math.floor(hint.complexity * JEV_TIERS.length));
  return JEV_TIERS[index];
}

/** The deliberation the hint states, or null. Only the `deliberation` key feeds it. */
export function hintDeliberation(hint) {
  return typeof hint?.deliberation === "number" ? hint.deliberation : null;
}

/**
 * What `x-red-router-decision: off` turns off for one request. It always stops the
 * router's own tool routing. It stops the model decision too, unless the same request
 * carries a hint with a deliberation: a client that states its classification is asking
 * an auto combo to pick its member from it. Redcode sends both once its own System One
 * has chosen the turn's tools.
 */
export function decisionOptOut(headerValue, hint) {
  const off = typeof headerValue === "string" && headerValue.trim().toLowerCase() === "off";
  return { tools: off, model: off && hintDeliberation(hint) === null };
}

/**
 * What a request's detail row records about the hint: the parsed values and which
 * routing steps used them instead of asking the decision model.
 */
export function hintDetail(hint, usedFor = []) {
  if (!hint) return null;
  return {
    source: HINT_SOURCE,
    complexity: typeof hint.complexity === "number" ? hint.complexity : null,
    deliberation: hintDeliberation(hint),
    needs_tool: typeof hint.needsTool === "boolean" ? hint.needsTool : null,
    tier: hintTier(hint),
    used_for: [...new Set(usedFor)],
  };
}
