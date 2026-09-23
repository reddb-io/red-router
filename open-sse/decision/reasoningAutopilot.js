// Reasoning autopilot: how much the model should think on this turn, raised and
// lowered from the decision model's `needs_reasoning` plus the deterministic
// signals in signals.js. Pure: the caller asks jev, keeps session state and
// applies the result through applyThinking, which maps the abstract level onto
// each provider's native knob (budget, effort, thinkingLevel…).

import { THINKING_ORDER, budgetToLevel } from "../translator/concerns/thinking.js";

export const AUTOPILOT_MODES = ["off", "shadow", "enforce"];

/** The ladder the autopilot moves on. "none"/"max" are reachable only as floor/ceiling. */
const LADDER = THINKING_ORDER;

export const DEFAULT_AUTOPILOT = {
  mode: "off",
  // Opt-in: API key ids and combo names the autopilot applies to. `all` covers
  // every request, including local requests without a key.
  all: false,
  apiKeys: [],
  combos: [],
  floor: "low",
  ceiling: "high",
  // Ask jev (one noul question) when no combo decision already measured it.
  askJevDirect: true,
  // Turns a level holds before it may drop again. Changing thinking invalidates
  // Anthropic's cached message prefix, so oscillating is not free.
  minDwellTurns: 2,
  timeoutMs: 1200,
};

// needs_reasoning (0..1) → level. Upper bounds, ascending.
const DELIBERATION_BANDS = [
  [0.15, "minimal"],
  [0.35, "low"],
  [0.6, "medium"],
  [0.8, "high"],
  [Infinity, "xhigh"],
];

// Causes that raise the level immediately, skipping the dwell.
const URGENT_CAUSES = new Set(["stall", "tool_error", "plan_mode", "explicit_think"]);

const indexOf = (level) => LADDER.indexOf(level);
const valid = (level) => indexOf(level) !== -1;

export function normalizeAutopilotConfig(raw) {
  const config = { ...DEFAULT_AUTOPILOT, ...(raw || {}) };
  if (!AUTOPILOT_MODES.includes(config.mode)) config.mode = "off";
  if (!valid(config.floor)) config.floor = DEFAULT_AUTOPILOT.floor;
  if (!valid(config.ceiling)) config.ceiling = DEFAULT_AUTOPILOT.ceiling;
  if (indexOf(config.floor) > indexOf(config.ceiling)) config.floor = config.ceiling;
  if (!Array.isArray(config.apiKeys)) config.apiKeys = [];
  if (!Array.isArray(config.combos)) config.combos = [];
  if (!Number.isFinite(config.minDwellTurns) || config.minDwellTurns < 0) config.minDwellTurns = DEFAULT_AUTOPILOT.minDwellTurns;
  if (!Number.isFinite(config.timeoutMs)) config.timeoutMs = DEFAULT_AUTOPILOT.timeoutMs;
  config.all = config.all === true;
  config.askJevDirect = config.askJevDirect !== false;
  return config;
}

/** Whether the autopilot covers this request. */
export function autopilotApplies(config, { apiKeyId = null, comboName = null } = {}) {
  if (!config || config.mode === "off") return false;
  if (config.all) return true;
  if (apiKeyId && config.apiKeys.includes(apiKeyId)) return true;
  return !!comboName && config.combos.includes(comboName);
}

export function levelFromDeliberation(deliberation) {
  if (typeof deliberation !== "number" || !Number.isFinite(deliberation)) return null;
  return DELIBERATION_BANDS.find(([bound]) => deliberation < bound)[1];
}

/** A client thinking config ({mode, level|budget}) as a ladder level, or null. */
function clientLevel(effort) {
  if (!effort) return null;
  if (effort.mode === "none") return "none";
  if (effort.mode === "level" && valid(effort.level)) return effort.level;
  if (effort.mode === "budget") return budgetToLevel(effort.budget);
  return null;
}

const step = (level, delta) => LADDER[Math.max(0, Math.min(LADDER.length - 1, indexOf(level) + delta))];
const atLeast = (level, min) => (indexOf(level) < indexOf(min) ? min : level);
const clamp = (level, floor, ceiling) => LADDER[Math.max(indexOf(floor), Math.min(indexOf(ceiling), indexOf(level)))];

/**
 * @param {object} args
 * @param {object} args.signals       extractSignals() output
 * @param {number|null} args.deliberation needs_reasoning from jev, when measured
 * @param {{level:string, changedAt:number, turn:number}|null} args.previous session state
 * @param {object} args.config        normalizeAutopilotConfig() output
 * @returns {{level:string, cause:string, from:string|null, base:string, state:object}}
 */
export function decideReasoningLevel({ signals = {}, deliberation = null, previous = null, config = DEFAULT_AUTOPILOT }) {
  const from = clientLevel(signals.clientEffort);
  const turn = (previous?.turn ?? 0) + 1;

  // Bookkeeping never needs thought, whatever the floor says for real work.
  if (signals.housekeeping) {
    // A side call, not a turn of the session: leave the session state as it was.
    return { level: "none", cause: "housekeeping", from, base: "none", state: previous };
  }

  const measured = levelFromDeliberation(deliberation);
  let level = measured || from || "medium";
  let cause = measured ? "jev" : from ? "client" : "default";
  const base = level;

  if (signals.stall) { level = step(level, 1); cause = "stall"; }
  else if (signals.lastToolError) { level = step(level, 1); cause = "tool_error"; }
  if (signals.planMode && indexOf(level) < indexOf("high")) { level = atLeast(level, "high"); cause = "plan_mode"; }
  if (signals.explicitThink && indexOf(level) < indexOf("high")) { level = atLeast(level, "high"); cause = "explicit_think"; }
  // Carrying out a plan the model already made: one notch less, unless something went wrong.
  if (signals.turnKind === "tool_continuation" && !signals.stall && !signals.lastToolError && !signals.planMode && !signals.explicitThink) {
    level = step(level, -1);
    cause = `${cause}+continuation`;
  }

  level = clamp(level, config.floor, config.ceiling);

  // Hysteresis: hold the previous level for minDwellTurns unless the move is urgent upward.
  if (previous && valid(previous.level) && previous.level !== level) {
    const rising = indexOf(level) > indexOf(previous.level);
    const urgent = rising && URGENT_CAUSES.has(cause);
    if (!urgent && turn - previous.changedAt < config.minDwellTurns) {
      return { level: previous.level, cause: "dwell", from, base, state: { ...previous, turn } };
    }
  }
  const changed = !previous || previous.level !== level;
  return { level, cause, from, base, state: { level, changedAt: changed ? turn : previous.changedAt, turn } };
}

/** Parse a per-request override header: "off", or a ladder level to force. */
export function parseReasoningHeader(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "off" || v === "auto") return { mode: v };
  return valid(v) ? { mode: "force", level: v } : null;
}
