/**
 * Reasoning autopilot: the effort ("thinking level") of one request.
 *
 * This is the "auto" of the dual reasoning mode. A client that lets the router pick (RedCode's
 * `auto` effort variant sends `x-red-router-reasoning: auto`) gets System One's read on how much
 * deliberation the next step needs, turned into a level on the effort ladder; whoever states a
 * level themselves is never overridden. The pure decision (`decideReasoningLevel`) and the
 * signals live in open-sse/decision; this module adds the request-scoped glue: header and hint
 * precedence, the per-session state that keeps a level stable through a turn's tool loop, and the
 * System One question. Precedence, first match wins:
 *
 *   1. `x-red-router-reasoning: off`     -> null: the client's own thinking config is kept.
 *   2. `x-red-router-reasoning: <level>` -> that level (cause "header").
 *   3. hint `effort=<level>`              -> that level (cause "hint"), no System One call.
 *   4. `x-red-router-reasoning: auto`     -> the autopilot, enforced for this request even when
 *      the configured mode is off or the key is not covered.
 *   5. otherwise the configured autopilot (settings.reasoningAutopilot), when it covers the key
 *      or combo.
 */

import { createHash } from "node:crypto";
import {
  autopilotApplies,
  decideReasoningLevel,
  normalizeAutopilotConfig,
  parseReasoningHeader,
  type AutopilotState,
} from "@omniroute/open-sse/decision/reasoningAutopilot.ts";
import { hintEffort, type ClassificationHint } from "@omniroute/open-sse/decision/clientHint.ts";
import { extractSignals, signalsMeta } from "@omniroute/open-sse/decision/signals.ts";
import { localDeliberation } from "@omniroute/open-sse/decision/localScorer.ts";

type JsonRecord = Record<string, unknown>;
type Log = { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };

export interface ReasoningPlan {
  mode: string;
  level: string;
  cause: string;
  from: string | null;
  deliberation: number | null;
  /** Null in shadow mode: the level is reported but not applied. */
  target: { mode: "set"; level: string } | null;
  signals?: Record<string, unknown> | null;
}

export interface PlanReasoningInput {
  body: JsonRecord;
  settings: JsonRecord | null | undefined;
  /** `x-red-router-reasoning` request header value. */
  headerValue?: string | null;
  hint?: ClassificationHint | null;
  apiKey?: string | null;
  apiKeyId?: string | null;
  comboName?: string | null;
  sessionId?: string | null;
  userAgent?: string;
  /** A deliberation the caller already measured (an auto combo's decision, or the hint). */
  deliberation?: number | null;
  contextWindow?: number | null;
  /**
   * The upstream caches the conversation and a change of thinking settings throws that cache
   * away (Claude): the level then moves far less often. See `CACHE_SENSITIVE_DWELL_TURNS`.
   */
  cacheSensitive?: boolean;
  log?: Log;
  /** Asks System One for deliberation (0..1); null when unavailable. Injected by the chat path. */
  askDeliberation?: (body: JsonRecord) => Promise<number | null>;
}

interface SessionEntry {
  state: AutopilotState;
  memo: { hash: string; deliberation: number } | null;
}

/**
 * Turns a level is held when a change would invalidate the provider's prompt cache. A change
 * re-writes the whole conversation at 1.25x, so the level only moves after this many turns
 * (upward moves for trouble stay immediate).
 */
export const CACHE_SENSITIVE_DWELL_TURNS = 8;

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX_ENTRIES = 5000;

/** Bounded, in-process, expiring — like the combo rotation state. */
function sessionStore(max: number) {
  const entries = new Map<string, { value: SessionEntry; expiresAt: number }>();
  return {
    read(key: string): SessionEntry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    write(key: string, value: SessionEntry) {
      if (!entries.has(key) && entries.size >= max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + SESSION_TTL_MS });
    },
    clear() {
      entries.clear();
    },
  };
}

const sessions = sessionStore(SESSION_MAX_ENTRIES);

export function resetReasoningSessions(): void {
  sessions.clear();
}

const sha = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

/** `X-RedRouter-Reasoning: <client level or ->-><level>; cause=<cause>[; shadow]`. */
export function reasoningResponseHeaderValue(plan: ReasoningPlan): string {
  return `${plan.from || "-"}->${plan.level}; cause=${plan.cause}${plan.target ? "" : "; shadow"}`;
}

export async function planReasoning(input: PlanReasoningInput): Promise<ReasoningPlan | null> {
  const { body, settings, log } = input;
  const override = parseReasoningHeader(input.headerValue ?? null);
  if (override?.mode === "off") return null;
  if (override?.mode === "force" && override.level) {
    log?.info?.("REASONING", `forced ${override.level} by header`);
    return forced(override.level, "header");
  }
  const effort = hintEffort(input.hint);
  if (effort) {
    log?.info?.("REASONING", `forced ${effort} by hint`);
    return forced(effort, "hint");
  }

  const configured = normalizeAutopilotConfig(
    (settings?.reasoningAutopilot as JsonRecord | undefined) ?? null
  );
  const requested = override?.mode === "auto";
  if (
    !requested &&
    !autopilotApplies(configured, { apiKeyId: input.apiKeyId, comboName: input.comboName })
  ) {
    return null;
  }
  const base = requested ? { ...configured, mode: "enforce" } : configured;
  const config = input.cacheSensitive
    ? { ...base, minDwellTurns: Math.max(base.minDwellTurns, CACHE_SENSITIVE_DWELL_TURNS) }
    : base;

  const signals = extractSignals(body, {
    userAgent: input.userAgent ?? "",
    hint: (input.hint as JsonRecord | null | undefined) ?? null,
  });
  const key = sha(`${input.apiKey || "local"}:${input.sessionId || "ephemeral"}`, 24);
  const session = sessions.read(key);
  const turnId = sha(`${signals.humanTurns}:${signals.humanText || ""}`, 16);
  const withinTurn = session?.state?.humanTurn === turnId;

  let measured: number | null = typeof input.deliberation === "number" ? input.deliberation : null;
  const wantsJev =
    measured === null &&
    !withinTurn &&
    !signals.housekeeping &&
    !signals.encryptedTask &&
    config.askJevDirect &&
    !!input.askDeliberation;
  if (wantsJev) {
    if (session?.memo?.hash === turnId) {
      measured = session.memo.deliberation;
    } else {
      measured = await input.askDeliberation!(body).catch(() => null);
    }
  }

  const result = decideReasoningLevel({
    signals: signals as unknown as JsonRecord,
    deliberation: measured,
    // No answer from System One: keep the level the session already has rather than guess,
    // and only on a session's first turn fall back to the deterministic local score.
    jevFailed: wantsJev && measured === null,
    localDeliberation:
      wantsJev && measured === null
        ? localDeliberation(signals as unknown as JsonRecord).score
        : null,
    turnId,
    contextWindow: input.contextWindow ?? null,
    previous: session?.state ?? null,
    config,
  });
  const memo =
    measured !== null && typeof input.deliberation !== "number"
      ? { hash: turnId, deliberation: measured }
      : (session?.memo ?? null);
  if (result.state || memo) sessions.write(key, { state: result.state, memo });

  log?.info?.(
    "REASONING",
    `${result.from || "-"}->${result.level} (${result.cause}` +
      `${measured !== null ? `, deliberation ${measured.toFixed(2)}` : ""}` +
      `${requested ? ", auto" : ""}${config.mode === "shadow" ? ", shadow" : ""})`
  );

  return {
    mode: config.mode,
    level: result.level,
    cause: result.cause,
    from: result.from,
    deliberation: measured,
    target: config.mode === "enforce" ? { mode: "set", level: result.level } : null,
    signals: signalsMeta(signals),
  };
}

function forced(level: string, cause: "header" | "hint"): ReasoningPlan {
  return {
    mode: "enforce",
    level,
    cause,
    from: null,
    deliberation: null,
    target: { mode: "set", level },
  };
}
