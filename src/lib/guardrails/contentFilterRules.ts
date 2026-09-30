/**
 * Content filter rules: shape, validation and matching. Pure module with no server imports,
 * so the settings schema, the dashboard and the guardrail all share one definition.
 *
 * Matching is deliberately limited to what stays cheap on untrusted input:
 * - keywords are literal substrings, compared case-insensitively, optionally as whole words;
 *   they never touch the regex engine;
 * - regex rules pass a conservative validator (no backreferences, no lookaround, no nested or
 *   alternating repetition, few unbounded quantifiers) and are run over bounded windows of text.
 *   V8 has no in-process regex timeout, so this narrows the risk rather than proving it away.
 */

export const CONTENT_FILTER_MAX_RULES = 100;
export const CONTENT_FILTER_MAX_PATTERN_LENGTH = 200;
/** A regex sees at most this many characters at a time. */
export const CONTENT_FILTER_WINDOW = 8192;
const WINDOW_OVERLAP = 256;
/** Everything past this many characters of one request or response is not scanned. */
export const CONTENT_FILTER_MAX_SCAN_CHARS = 262_144;

export const CONTENT_FILTER_RULE_TYPES = ["keyword", "regex"] as const;
export const CONTENT_FILTER_SCOPES = ["request", "response", "both"] as const;
export const CONTENT_FILTER_ACTIONS = ["block", "flag"] as const;

export type ContentFilterRuleType = (typeof CONTENT_FILTER_RULE_TYPES)[number];
export type ContentFilterScope = (typeof CONTENT_FILTER_SCOPES)[number];
export type ContentFilterAction = (typeof CONTENT_FILTER_ACTIONS)[number];

export interface ContentFilterRule {
  id: string;
  label: string;
  type: ContentFilterRuleType;
  pattern: string;
  scope: ContentFilterScope;
  action: ContentFilterAction;
  enabled: boolean;
  /** Keyword rules only: match whole words instead of any substring. */
  wholeWord?: boolean;
}

export interface ContentFilterConfig {
  enabled: boolean;
  rules: ContentFilterRule[];
}

/** Shown to the caller when a rule blocks. Never includes the rule or the matched text. */
export const CONTENT_FILTER_REQUEST_BLOCK_MESSAGE = "Request blocked by content policy";
export const CONTENT_FILTER_RESPONSE_BLOCK_MESSAGE = "Response blocked by content policy";

const MAX_UNBOUNDED_QUANTIFIERS = 5;
const MAX_BOUNDED_REPEAT = 100;
const MAX_ALTERNATION_GROUP_REPEAT = 5;

interface GroupState {
  hasAlternation: boolean;
  hasUnbounded: boolean;
}

/** Returns why a regex pattern is refused, or null when it is acceptable. */
export function validateRegexPattern(pattern: string): string | null {
  if (typeof pattern !== "string" || pattern.length === 0) return "Pattern is empty";
  if (pattern.length > CONTENT_FILTER_MAX_PATTERN_LENGTH) return "Pattern is too long";

  const stack: GroupState[] = [{ hasAlternation: false, hasUnbounded: false }];
  let lastAtom: "none" | "atom" | "dot" | GroupState = "none";
  let unboundedCount = 0;
  let unboundedDots = 0;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return "Pattern ends with a lone backslash";
      if (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<")) {
        return "Backreferences are not supported";
      }
      lastAtom = "atom";
      i += 2;
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      let closed = false;
      while (j < pattern.length) {
        if (pattern[j] === "\\") j += 2;
        else if (pattern[j] === "]") {
          closed = true;
          break;
        } else j += 1;
      }
      if (!closed) return "Unterminated character class";
      lastAtom = "atom";
      i = j + 1;
      continue;
    }

    if (ch === "(") {
      if (pattern[i + 1] === "?") {
        if (pattern[i + 2] !== ":") return "Lookaround and named groups are not supported";
        i += 3;
      } else {
        i += 1;
      }
      stack.push({ hasAlternation: false, hasUnbounded: false });
      lastAtom = "none";
      continue;
    }

    if (ch === ")") {
      if (stack.length < 2) return "Unbalanced parentheses";
      lastAtom = stack.pop() as GroupState;
      i += 1;
      continue;
    }

    if (ch === "|") {
      stack[stack.length - 1].hasAlternation = true;
      lastAtom = "none";
      i += 1;
      continue;
    }

    let quantifier: { unbounded: boolean; max: number; length: number } | null = null;
    if (ch === "*" || ch === "+") quantifier = { unbounded: true, max: Infinity, length: 1 };
    else if (ch === "?") quantifier = { unbounded: false, max: 1, length: 1 };
    else if (ch === "{") {
      const brace = /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/.exec(pattern.slice(i));
      if (brace) {
        const min = Number(brace[1]);
        const unbounded = brace[2] === "," && brace[3] === "";
        const max = brace[2] === "," ? (brace[3] === "" ? Infinity : Number(brace[3])) : min;
        if (!unbounded && max > MAX_BOUNDED_REPEAT) return "Repeat count is too large";
        quantifier = { unbounded, max, length: brace[0].length };
      }
    }

    if (quantifier) {
      if (lastAtom === "none") return "Quantifier has nothing to repeat";
      const parent = stack[stack.length - 1];
      if (typeof lastAtom === "object") {
        const isOptionalOnly = quantifier.max === 1;
        if (lastAtom.hasUnbounded && !isOptionalOnly) return "Nested repetition is not supported";
        if (
          lastAtom.hasAlternation &&
          (quantifier.unbounded || (!isOptionalOnly && quantifier.max > MAX_ALTERNATION_GROUP_REPEAT))
        ) {
          return "Alternation inside a repeated group is not supported";
        }
        if (lastAtom.hasUnbounded) parent.hasUnbounded = true;
      }
      if (quantifier.unbounded) {
        parent.hasUnbounded = true;
        unboundedCount += 1;
        if (lastAtom === "dot") unboundedDots += 1;
        if (unboundedCount > MAX_UNBOUNDED_QUANTIFIERS) return "Too many unbounded repetitions";
        if (unboundedDots > 1) return "Only one unbounded wildcard is allowed";
      }
      i += quantifier.length;
      if (pattern[i] === "?") i += 1; // lazy modifier
      lastAtom = "atom";
      continue;
    }

    lastAtom = ch === "." ? "dot" : "atom";
    i += 1;
  }

  if (stack.length !== 1) return "Unbalanced parentheses";
  try {
    new RegExp(pattern, "i");
  } catch {
    return "Pattern is not a valid regular expression";
  }
  return null;
}

// --- Matching ------------------------------------------------------------------------------

export interface CompiledContentRule {
  id: string;
  action: ContentFilterAction;
  scope: ContentFilterScope;
  matches(text: string, lowered: string): boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function keywordFound(haystack: string, needle: string, wholeWord: boolean): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!wholeWord) return true;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] ?? "";
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true;
    from = at + 1;
  }
}

function regexFound(regex: RegExp, text: string): boolean {
  if (text.length <= CONTENT_FILTER_WINDOW) return regex.test(text);
  const step = CONTENT_FILTER_WINDOW - WINDOW_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    if (regex.test(text.slice(start, start + CONTENT_FILTER_WINDOW))) return true;
    if (start + CONTENT_FILTER_WINDOW >= text.length) break;
  }
  return false;
}

/** Compiles the enabled, valid rules. A rule that fails validation is dropped, never thrown. */
export function compileContentFilterRules(rules: readonly ContentFilterRule[]): CompiledContentRule[] {
  const compiled: CompiledContentRule[] = [];
  for (const rule of rules.slice(0, CONTENT_FILTER_MAX_RULES)) {
    if (!rule || rule.enabled !== true || typeof rule.pattern !== "string" || !rule.pattern) continue;
    if (rule.pattern.length > CONTENT_FILTER_MAX_PATTERN_LENGTH) continue;
    if (rule.type === "keyword") {
      const needle = rule.pattern.toLowerCase();
      const wholeWord = rule.wholeWord === true;
      compiled.push({
        id: rule.id,
        action: rule.action,
        scope: rule.scope,
        matches: (_text, lowered) => keywordFound(lowered, needle, wholeWord),
      });
    } else if (rule.type === "regex") {
      if (validateRegexPattern(rule.pattern) !== null) continue;
      const regex = new RegExp(rule.pattern, "i");
      compiled.push({
        id: rule.id,
        action: rule.action,
        scope: rule.scope,
        matches: (text) => regexFound(regex, text),
      });
    }
  }
  return compiled;
}

export function ruleAppliesTo(scope: ContentFilterScope, stage: "request" | "response"): boolean {
  return scope === "both" || scope === stage;
}

/** Ids of the rules that match, in rule order, for the given stage. */
export function findMatchingRules(
  texts: readonly string[],
  rules: readonly CompiledContentRule[],
  stage: "request" | "response"
): CompiledContentRule[] {
  const applicable = rules.filter((rule) => ruleAppliesTo(rule.scope, stage));
  if (applicable.length === 0 || texts.length === 0) return [];

  const segments: Array<{ text: string; lowered: string }> = [];
  let budget = CONTENT_FILTER_MAX_SCAN_CHARS;
  for (const text of texts) {
    if (budget <= 0) break;
    const slice = text.length > budget ? text.slice(0, budget) : text;
    budget -= slice.length;
    if (slice) segments.push({ text: slice, lowered: slice.toLowerCase() });
  }

  return applicable.filter((rule) =>
    segments.some((segment) => rule.matches(segment.text, segment.lowered))
  );
}

// --- Text extraction -----------------------------------------------------------------------

/** String-valued keys that carry conversation text across the chat, Claude, Gemini and Responses shapes. */
const TEXT_KEYS = new Set([
  "content",
  "text",
  "input",
  "prompt",
  "system",
  "instructions",
  "output_text",
  "reasoning_content",
  "refusal",
]);
const MAX_WALK_DEPTH = 12;

/** Collects the text a person could have written or read, skipping ids, roles, urls and blobs. */
export function extractScanTexts(payload: unknown): string[] {
  const texts: string[] = [];
  let collected = 0;

  const walk = (node: unknown, textual: boolean, depth: number) => {
    if (collected >= CONTENT_FILTER_MAX_SCAN_CHARS || depth > MAX_WALK_DEPTH) return;
    if (typeof node === "string") {
      if (textual && node) {
        texts.push(node);
        collected += node.length;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, textual, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, TEXT_KEYS.has(key), depth + 1);
      }
    }
  };

  walk(payload, typeof payload === "string", 0);
  return texts;
}

// --- Config normalisation ------------------------------------------------------------------

function isRuleShape(value: unknown): value is ContentFilterRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.id === "string" &&
    rule.id.length > 0 &&
    typeof rule.pattern === "string" &&
    (CONTENT_FILTER_RULE_TYPES as readonly unknown[]).includes(rule.type) &&
    (CONTENT_FILTER_SCOPES as readonly unknown[]).includes(rule.scope) &&
    (CONTENT_FILTER_ACTIONS as readonly unknown[]).includes(rule.action)
  );
}

/** Reads the stored setting defensively; anything malformed degrades to "off, no rules". */
export function normalizeContentFilterConfig(raw: unknown): ContentFilterConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rules = Array.isArray(record.rules)
    ? record.rules
        .filter(isRuleShape)
        .slice(0, CONTENT_FILTER_MAX_RULES)
        .map((rule) => ({
          id: rule.id,
          label: typeof rule.label === "string" ? rule.label : "",
          type: rule.type,
          pattern: rule.pattern,
          scope: rule.scope,
          action: rule.action,
          enabled: (rule as { enabled?: unknown }).enabled === true,
          ...(rule.wholeWord === true ? { wholeWord: true } : {}),
        }))
    : [];
  return { enabled: record.enabled === true, rules };
}
