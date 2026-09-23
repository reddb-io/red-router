// Deterministic signals about a request, read from the raw client body before any
// decision call. Pure and cheap: routing uses them as hard floors and short-circuits,
// and the reasoning level builds on them. Nothing here asks a model.

import {
  EXPLICIT_THINK_PATTERN,
  HARNESS_SYSTEM_UA,
  HOUSEKEEPING_SENTINELS,
  PLAN_MODE_SENTINELS,
  STALL_THRESHOLD,
  STALL_WINDOW,
} from "../config/decisionSignals.js";
import { estimateRequestTokens, detectRequiredCapabilities } from "../services/combo.js";
import { extractThinking } from "../translator/concerns/thinkingUnified.js";
import { stripHarnessNoise, textOf, turnsOf } from "./state.js";

const TOOL_RESULT_TYPES = new Set(["tool_result", "function_call_output", "custom_tool_call_output"]);
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

function systemText(body) {
  const parts = [];
  if (body?.system) parts.push(textOf(body.system));
  if (typeof body?.instructions === "string") parts.push(body.instructions);
  const sys = body?.systemInstruction?.parts || body?.system_instruction?.parts;
  if (Array.isArray(sys)) parts.push(textOf(sys));
  for (const msg of body?.messages || []) {
    if (msg?.role === "system" || msg?.role === "developer") parts.push(textOf(msg.content));
  }
  return parts.join("\n");
}

function isToolResultItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.role === "tool" || item.role === "function") return true;
  if (TOOL_RESULT_TYPES.has(item.type)) return true;
  const content = Array.isArray(item.content) ? item.content : null;
  return !!content?.length && content.every((b) => TOOL_RESULT_TYPES.has(b?.type));
}

function isHumanItem(item) {
  if (!item || typeof item !== "object" || isToolResultItem(item)) return false;
  if (item.type && item.type !== "message") return false;
  return item.role === "user" || (item.role === undefined && item.type === "message");
}

/**
 * Tool calls and their outcomes in transcript order, across the OpenAI chat,
 * Claude and Responses shapes. `error` is only known where the shape carries it
 * (Claude `is_error`, Responses `status`).
 */
export function toolCallsOf(body) {
  const turns = turnsOf(body) || [];
  const calls = [];
  const byId = new Map();
  const add = (id, name, args) => {
    const call = { name: name || "tool", args: typeof args === "string" ? args : JSON.stringify(args ?? {}), error: false };
    calls.push(call);
    if (id) byId.set(id, call);
  };
  const markError = (id, error) => {
    const call = id ? byId.get(id) : null;
    if (call && error) call.error = true;
  };

  for (const item of turns) {
    if (!item || typeof item !== "object") continue;
    for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
      add(call?.id, call?.function?.name || call?.name, call?.function?.arguments ?? call?.arguments);
    }
    if (TOOL_CALL_TYPES.has(item.type)) add(item.call_id || item.id, item.name, item.arguments ?? item.input);
    if (TOOL_RESULT_TYPES.has(item.type)) markError(item.call_id, item.status === "error" || item.status === "failed");
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "tool_use") add(block.id, block.name, block.input);
        if (block?.type === "tool_result") markError(block.tool_use_id, block.is_error === true || block.status === "error");
      }
    }
  }
  return calls;
}

/** The newest call repeated (same name + args) or failed often in the recent window. */
export function detectStall(calls) {
  const recent = calls.slice(-STALL_WINDOW);
  if (recent.length < STALL_THRESHOLD) return false;
  const newest = recent[recent.length - 1];
  const repeats = recent.filter((c) => c.name === newest.name && c.args === newest.args).length;
  const errors = recent.filter((c) => c.error).length;
  return repeats >= STALL_THRESHOLD || errors >= STALL_THRESHOLD;
}

/** Text of the newest human message, harness blocks included (sentinels live there). */
function lastHumanRaw(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isHumanItem(turns[i])) return textOf(turns[i].content ?? turns[i].parts);
  }
  return "";
}

/** Everything after the newest assistant turn: where per-turn reminders are injected. */
function trailingText(turns) {
  const parts = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const role = turns[i]?.role;
    if (role === "assistant" || role === "model") break;
    parts.unshift(textOf(turns[i]?.content ?? turns[i]?.parts));
  }
  return parts.join("\n");
}

const includesAny = (text, sentinels) => sentinels.some((s) => text.includes(s));

/**
 * A delegated agent task whose content is encrypted (Codex subagents receive an
 * `agent_message` with an `encrypted_content` part). The decision model would only
 * see ciphertext, so routing falls back to the deterministic signals.
 */
export function isEncryptedTask(body) {
  const turns = turnsOf(body) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const item = turns[i];
    if (isToolResultItem(item) || TOOL_CALL_TYPES.has(item?.type)) continue;
    if (item?.type !== "agent_message" || !Array.isArray(item.content)) return false;
    return item.content.some((part) => part?.type === "encrypted_content" && part.encrypted_content);
  }
  return false;
}

/**
 * @param {object} body raw client body (before translation)
 * @param {object} [ctx]
 * @param {string} [ctx.userAgent]
 */
export function extractSignals(body, { userAgent = "" } = {}) {
  const turns = turnsOf(body) || [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const calls = toolCallsOf(body);
  const last = turns[turns.length - 1];
  const humanRaw = lastHumanRaw(turns);
  const recentText = trailingText(turns);
  const sys = systemText(body);

  const housekeeping = tools.length === 0 && includesAny(`${sys}\n${recentText}`, HOUSEKEEPING_SENTINELS);
  const planMode = includesAny(recentText, PLAN_MODE_SENTINELS);
  const humanText = stripHarnessNoise(humanRaw);
  const clientEffort = extractThinking(body);

  return {
    housekeeping,
    planMode,
    stall: detectStall(calls),
    lastToolError: calls.length > 0 && calls[calls.length - 1].error,
    explicitThink: EXPLICIT_THINK_PATTERN.test(humanText),
    turnKind: isToolResultItem(last) ? "tool_continuation" : "human",
    humanText,
    contextTokens: estimateRequestTokens(body),
    hasMedia: [...detectRequiredCapabilities(body)].some((cap) => cap === "vision" || cap === "pdf"),
    toolCount: tools.length,
    toolCalls: calls.length,
    clientEffort: clientEffort || null,
    harnessSystem: HARNESS_SYSTEM_UA.test(userAgent || ""),
    encryptedTask: isEncryptedTask(body),
  };
}

/** The subset worth persisting next to a decision (no free text). */
export function signalsMeta(signals) {
  if (!signals) return null;
  const { humanText, clientEffort, ...rest } = signals;
  return { ...rest, clientEffort: clientEffort?.level || clientEffort?.mode || null };
}
