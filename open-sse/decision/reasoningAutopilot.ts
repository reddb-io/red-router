// Reasoning autopilot: how much the model should think on this turn, raised and
// lowered from the decision model's `needs_reasoning` plus the deterministic
// signals in signals.js. Pure: the caller asks jev, keeps session state and
// applies the result through applyThinking, which maps the abstract level onto
// each provider's native knob (budget, effort, thinkingLevel…).
//
// Ported 1:1 from the legacy fork (open-sse/decision/reasoningAutopilot.js @ c66f917c).

import { THINKING_ORDER, budgetToLevel } from "../translator/concerns/thinking.ts";
import { FRUSTRATION_STEP_UP } from "../config/decisionSignals.ts";
import type { ThinkingIntent } from "../translator/concerns/thinkingUnified.ts";

type JsonRecord = Record<string, unknown>;

export const AUTOPILOT_MODES = ["off", "shadow", "enforce"];

/** The ladder the autopilot moves on. "none"/"max" are reachable only as floor/ceiling. */
export const REASONING_LADDER = THINKING_ORDER;
const LADDER = REASONING_LADDER;

/** Values x-red-router-reasoning accepts: off, auto, or a ladder level to force. */
export const REASONING_HEADER_VALUES = ["off", "auto", ...REASONING_LADDER];

export const DEFAULT_AUTOPILOT = {
  mode: "off",
  // Opt-in: API key ids and combo names the autopilot applies to. `all` covers
  // every request, including local requests without a key.
  all: false,
  apiKeys: [] as string[],
  combos: [] as string[],
  floor: "low",
  ceiling: "high",
  // Ask jev (one noul question) when no combo decision already measured it.
  askJevDirect: true,
  // Turns a level holds before it may drop again. Changing thinking invalidates
  // Anthropic's cached message prefix, so oscillating is not free.
  minDwellTurns: 2,
  timeoutMs: 1200,
  // One notch more when the request fills more than this fraction of the serving
  // model's context window: a long context is harder to reason over. 0 disables.
  contextFraction: 0.5,
};

export type AutopilotConfig = typeof DEFAULT_AUTOPILOT & {
  mode: string;
};

// needs_reasoning (0..1) → level. Upper bounds, ascending.
const DELIBERATION_BANDS: [number, string][] = [
  [0.15, "minimal"],
  [0.35, "low"],
  [0.6, "medium"],
  [0.8, "high"],
  [Infinity, "xhigh"],
];

// Causes that raise the level immediately, skipping the dwell.
const URGENT_CAUSES = new Set([
  "stall",
  "tool_error",
  "feedback",
  "frustration",
  "plan_mode",
  "explicit_think",
]);

const indexOf = (level: string) => LADDER.indexOf(level);
const valid = (level: unknown) => indexOf(String(level)) !== -1;

export function normalizeAutopilotConfig(raw: JsonRecord | null): AutopilotConfig {
  const config: JsonRecord = { ...DEFAULT_AUTOPILOT, ...(raw || {}) };
  if (!AUTOPILOT_MODES.includes(config.mode as string)) config.mode = "off";
  if (!valid(config.floor)) config.floor = DEFAULT_AUTOPILOT.floor;
  if (!valid(config.ceiling)) config.ceiling = DEFAULT_AUTOPILOT.ceiling;
  if (indexOf(config.floor as string) > indexOf(config.ceiling as string))
    config.floor = config.ceiling;
  if (!Array.isArray(config.apiKeys)) config.apiKeys = [];
  if (!Array.isArray(config.combos)) config.combos = [];
  if (!Number.isFinite(config.minDwellTurns) || (config.minDwellTurns as number) < 0)
    config.minDwellTurns = DEFAULT_AUTOPILOT.minDwellTurns;
  if (!Number.isFinite(config.timeoutMs)) config.timeoutMs = DEFAULT_AUTOPILOT.timeoutMs;
  if (
    !Number.isFinite(config.contextFraction) ||
    (config.contextFraction as number) < 0 ||
    (config.contextFraction as number) > 1
  )
    config.contextFraction = DEFAULT_AUTOPILOT.contextFraction;
  config.all = config.all === true;
  config.askJevDirect = config.askJevDirect !== false;
  return config as unknown as AutopilotConfig;
}

/** Whether the autopilot covers this request. */
export function autopilotApplies(
  config: AutopilotConfig | null,
  {
    apiKeyId = null,
    comboName = null,
  }: { apiKeyId?: string | null; comboName?: string | null } = {}
): boolean {
  if (!config || config.mode === "off") return false;
  if (config.all) return true;
  if (apiKeyId && config.apiKeys.includes(apiKeyId)) return true;
  return !!comboName && config.combos.includes(comboName);
}

export function levelFromDeliberation(deliberation: unknown): string | null {
  if (typeof deliberation !== "number" || !Number.isFinite(deliberation)) return null;
  return DELIBERATION_BANDS.find(([bound]) => deliberation < bound)?.[1] ?? null;
}

/** A client thinking config ({mode, level|budget}) as a ladder level, or null. */
function clientLevel(effort: ThinkingIntent | null | undefined): string | null {
  if (!effort) return null;
  if (effort.mode === "none") return "none";
  if (effort.mode === "level" && valid(effort.level)) return effort.level;
  if (effort.mode === "budget") return budgetToLevel(effort.budget);
  return null;
}

const step = (level: string, delta: number) =>
  LADDER[Math.max(0, Math.min(LADDER.length - 1, indexOf(level) + delta))];
const atLeast = (level: string, min: string) => (indexOf(level) < indexOf(min) ? min : level);
const clamp = (level: string, floor: string, ceiling: string) =>
  LADDER[Math.max(indexOf(floor), Math.min(indexOf(ceiling), indexOf(level)))];

export type AutopilotState = {
  level: string;
  changedAt: number;
  turn: number;
  humanTurn?: string | null;
  loopStep?: boolean;
} | null;

export type ReasoningDecision = {
  level: string;
  cause: string;
  from: string | null;
  base: string;
  state: AutopilotState;
};

/**
 * The level for one request. The level moves only where the human speaks: a
 * request of a human turn already seen (its tool loop) holds the level, because
 * changing thinking mid-loop invalidates the provider's cached prefix. The one
 * exception is a single step up per human turn when the loop stalls or a tool
 * fails.
 */
export function decideReasoningLevel({
  signals = {},
  deliberation = null,
  jevFailed = false,
  localDeliberation: localDeliberationScore = null,
  turnId = null,
  contextWindow = null,
  previous = null,
  config = DEFAULT_AUTOPILOT,
}: {
  signals?: JsonRecord;
  deliberation?: number | null;
  jevFailed?: boolean;
  localDeliberation?: number | null;
  turnId?: string | null;
  contextWindow?: number | null;
  previous?: AutopilotState;
  config?: AutopilotConfig;
} = {}): ReasoningDecision {
  const from = clientLevel(signals.clientEffort as ThinkingIntent | null);

  // Bookkeeping never needs thought, whatever the floor says for real work.
  if (signals.housekeeping) {
    // A side call, not a turn of the session: leave the session state as it was.
    return { level: "none", cause: "housekeeping", from, base: "none", state: previous };
  }

  const known = previous && valid(previous.level);
  if (known && turnId !== null && previous.humanTurn === turnId)
    return holdWithinTurn({ signals, from, previous, config });

  const turn = (previous?.turn ?? 0) + 1;
  const measured = levelFromDeliberation(deliberation);
  const kept = !measured && jevFailed && known;
  const local =
    !measured && !kept && jevFailed && typeof localDeliberationScore === "number"
      ? levelFromDeliberation(localDeliberationScore)
      : null;
  let level = measured || (kept ? previous.level : null) || local || from || "medium";
  let cause = measured ? "jev" : kept ? "kept" : local ? "local" : from ? "client" : "default";
  const base = level as string;

  const trouble = troubleCause(signals);
  // One notch for trouble or for a heavy context, never both: each is a guess.
  if (trouble) {
    level = step(level, 1);
    cause = trouble;
  } else if (heavyContext(signals, contextWindow, config)) {
    level = step(level, 1);
    cause = "context";
  }
  if (signals.planMode && indexOf(level) < indexOf("high")) {
    level = atLeast(level, "high");
    cause = "plan_mode";
  }
  if (signals.explicitThink && indexOf(level) < indexOf("high")) {
    level = atLeast(level, "high");
    cause = "explicit_think";
  }
  const healthy = !trouble && !signals.planMode && !signals.explicitThink;
  // Carrying out a plan the model already made: one notch less, unless something went wrong.
  if (healthy && signals.turnKind === "tool_continuation") {
    level = step(level, -1);
    cause = `${cause}+continuation`;
  } else if (healthy && signals.userFeedback === "agrees") {
    // The human approved and the work goes on: the same effort is not needed to continue.
    level = step(level, -1);
    cause = `${cause}+agrees`;
  }

  level = clamp(level, config.floor, config.ceiling);
  const identity = { humanTurn: turnId, loopStep: false };

  // Hysteresis: hold the previous level for minDwellTurns unless the move is urgent upward.
  if (known && previous.level !== level) {
    const rising = indexOf(level) > indexOf(previous.level);
    const urgent = rising && URGENT_CAUSES.has(cause);
    if (!urgent && turn - previous.changedAt < config.minDwellTurns) {
      return {
        level: previous.level,
        cause: "dwell",
        from,
        base,
        state: { ...previous, ...identity, turn },
      };
    }
  }
  const changed = !known || previous.level !== level;
  return {
    level,
    cause,
    from,
    base,
    state: {
      level,
      changedAt: changed ? turn : previous.changedAt,
      turn,
      ...identity,
    },
  };
}

/** Inside a human turn's tool loop: the level holds, save one step up per turn on trouble. */
function holdWithinTurn({
  signals,
  from,
  previous,
  config,
}: {
  signals: JsonRecord;
  from: string | null;
  previous: AutopilotState;
  config: AutopilotConfig;
}): ReasoningDecision {
  const cause = signals.stall ? "stall" : signals.lastToolError ? "tool_error" : null;
  if (cause && !previous.loopStep) {
    const level = clamp(step(previous.level, 1), config.floor, config.ceiling);
    if (level !== previous.level) {
      return {
        level,
        cause,
        from,
        base: previous.level,
        state: { ...previous, level, changedAt: previous.turn, loopStep: true },
      };
    }
  }
  return { level: previous.level, cause: "hold", from, base: previous.level, state: previous };
}

/** Something went wrong that more thought may fix: the first cause that fires, or null. */
function troubleCause(signals: JsonRecord): string | null {
  if (signals.stall) return "stall";
  if (signals.lastToolError) return "tool_error";
  if (signals.userFeedback === "corrects" || signals.userFeedback === "rejects") return "feedback";
  if (typeof signals.frustration === "number" && signals.frustration >= FRUSTRATION_STEP_UP)
    return "frustration";
  return null;
}

function heavyContext(
  signals: JsonRecord,
  contextWindow: number | null,
  config: AutopilotConfig
): boolean {
  if (!(config.contextFraction > 0) || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return false;
  return (
    Number.isFinite(signals.contextTokens) &&
    Number(signals.contextTokens) > contextWindow * config.contextFraction
  );
}

/**
 * Parse the per-request header: "off" (leave the client's thinking alone), "auto"
 * (run the autopilot for this request) or a ladder level to force.
 */
export function parseReasoningHeader(value: unknown): { mode: string; level?: string } | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "off" || v === "auto") return { mode: v };
  return valid(v) ? { mode: "force", level: v } : null;
}
