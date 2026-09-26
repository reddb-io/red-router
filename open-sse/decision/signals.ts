// Deterministic signals about a request, read from the raw client body before any
// decision call. Pure and cheap: routing uses them as hard floors and short-circuits,
// and the reasoning level builds on them. Nothing here asks a model.
//
// Ported 1:1 from the legacy fork (open-sse/decision/signals.js @ c66f917c).
// Adaptation: `estimateRequestTokens` / `detectRequiredCapabilities` come from the
// local adapter (./contextProbe.ts) — the legacy combo service has no such exports
// in this base. `extractThinking` comes from translator/concerns/thinkingUnified.ts
// (slim port of the legacy thinkingUnified module).

import {
  EXPLICIT_THINK_PATTERN,
  FEEDBACK_AGREES_PATTERN,
  FEEDBACK_CORRECTS_PATTERN,
  FEEDBACK_REJECTS_PATTERN,
  FRUSTRATION_MARKERS,
  FRUSTRATION_SHOUT,
  HARNESS_SYSTEM_UA,
  HOUSEKEEPING_SENTINELS,
  PLAN_MODE_SENTINELS,
  STALL_THRESHOLD,
  STALL_WINDOW,
} from "../config/decisionSignals.ts";
import { detectRequiredCapabilities, estimateRequestTokens } from "./contextProbe.ts";
import { extractThinking } from "../translator/concerns/thinkingUnified.ts";
import { stripHarnessNoise, textOf, turnsOf } from "./state.ts";

type JsonRecord = Record<string, unknown>;

const TOOL_RESULT_TYPES = new Set([
  "tool_result",
  "function_call_output",
  "custom_tool_call_output",
]);
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

function systemText(body: unknown): string {
  const b = asRecord(body) || {};
  const parts: string[] = [];
  if (b.system) parts.push(textOf(b.system));
  if (typeof b.instructions === "string") parts.push(b.instructions);
  const sys = asRecord(b.systemInstruction)?.parts || asRecord(b.system_instruction)?.parts;
  if (Array.isArray(sys)) parts.push(textOf(sys));
  for (const msg of (b.messages as JsonRecord[]) || []) {
    const m = asRecord(msg);
    if (m?.role === "system" || m?.role === "developer") parts.push(textOf(m.content));
  }
  return parts.join("\n");
}

function isToolResultItem(item: unknown): boolean {
  const it = asRecord(item);
  if (!it) return false;
  if (it.role === "tool" || it.role === "function") return true;
  if (TOOL_RESULT_TYPES.has(it.type as string)) return true;
  const content = Array.isArray(it.content) ? it.content : null;
  if (!content?.some((block) => TOOL_RESULT_TYPES.has(asRecord(block)?.type as string)))
    return false;
  // Harnesses append reminders next to the results (Claude Code's <system-reminder>);
  // a message carrying nothing else is still a tool continuation, not a human turn.
  return content.every(
    (block) =>
      TOOL_RESULT_TYPES.has(asRecord(block)?.type as string) ||
      ((asRecord(block)?.type as string) === "text" &&
        !stripHarnessNoise((asRecord(block) as JsonRecord).text))
  );
}

function isHumanItem(item: unknown): boolean {
  const it = asRecord(item);
  if (!it || isToolResultItem(item)) return false;
  if (it.type && it.type !== "message") return false;
  return it.role === "user" || (it.role === undefined && it.type === "message");
}

export type ToolCall = { name: string; args: string; error: boolean };

/**
 * Tool calls and their outcomes in transcript order, across the OpenAI chat,
 * Claude and Responses shapes. `error` is only known where the shape carries it
 * (Claude `is_error`, Responses `status`).
 */
export function toolCallsOf(body: unknown): ToolCall[] {
  const turns = turnsOf(body) || [];
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const add = (id: unknown, name: unknown, args: unknown) => {
    const call: ToolCall = {
      name: (name as string) || "tool",
      args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      error: false,
    };
    calls.push(call);
    if (id) byId.set(String(id), call);
  };
  const markError = (id: unknown, error: boolean) => {
    const call = id ? byId.get(String(id)) : null;
    if (call && error) call.error = true;
  };

  for (const item of turns) {
    const it = asRecord(item);
    if (!it) continue;
    for (const call of (Array.isArray(it.tool_calls) ? it.tool_calls : []) as JsonRecord[]) {
      add(
        call?.id,
        asRecord(call?.function)?.name || call?.name,
        asRecord(call?.function)?.arguments ?? call?.arguments
      );
    }
    if (TOOL_CALL_TYPES.has(it.type as string))
      add(it.call_id || it.id, it.name, it.arguments ?? it.input);
    if (TOOL_RESULT_TYPES.has(it.type as string))
      markError(it.call_id, it.status === "error" || it.status === "failed");
    if (Array.isArray(it.content)) {
      for (const block of it.content as JsonRecord[]) {
        if (block?.type === "tool_use") add(block.id, block.name, block.input);
        if (block?.type === "tool_result")
          markError(block.tool_use_id, block.is_error === true || block.status === "error");
      }
    }
  }
  return calls;
}

/** The newest call repeated (same name + args) or failed often in the recent window. */
export function detectStall(calls: ToolCall[]): boolean {
  const recent = calls.slice(-STALL_WINDOW);
  if (recent.length < STALL_THRESHOLD) return false;
  const newest = recent[recent.length - 1];
  const repeats = recent.filter((c) => c.name === newest.name && c.args === newest.args).length;
  const errors = recent.filter((c) => c.error).length;
  return repeats >= STALL_THRESHOLD || errors >= STALL_THRESHOLD;
}

/** Text of the newest human message, harness blocks included (sentinels live there). */
function lastHumanRaw(turns: JsonRecord[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isHumanItem(turns[i])) return textOf(turns[i].content ?? turns[i].parts);
  }
  return "";
}

/** The human's own words: code and pasted output say nothing about their mood. */
function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/[\u2018\u2019]/g, "'");
}

/**
 * How the human judged the previous answer: "rejects", "corrects", "agrees", or
 * null when the message says nothing either way. Corrections win over agreement.
 */
export function detectFeedback(text: unknown): string | null {
  if (typeof text !== "string" || !text) return null;
  const normalized = proseOf(text);
  if (FEEDBACK_REJECTS_PATTERN.test(normalized)) return "rejects";
  if (FEEDBACK_CORRECTS_PATTERN.test(normalized)) return "corrects";
  if (FEEDBACK_AGREES_PATTERN.test(normalized)) return "agrees";
  return null;
}

/** Frustration markers in a human message (profanity, repetition, shouting, "?!"), 0..1. */
export function detectFrustration(text: unknown): number {
  if (typeof text !== "string" || !text) return 0;
  const normalized = proseOf(text);
  const markers = FRUSTRATION_MARKERS.reduce(
    (sum, marker) => sum + (marker.pattern.test(normalized) ? marker.weight : 0),
    0
  );
  const upper = (normalized.match(/\p{Lu}/gu) || []).length;
  const letters = upper + (normalized.match(/\p{Ll}/gu) || []).length;
  const shouting =
    letters >= FRUSTRATION_SHOUT.minLetters && upper / letters >= FRUSTRATION_SHOUT.ratio
      ? FRUSTRATION_SHOUT.weight
      : 0;
  return Math.min(1, Number((markers + shouting).toFixed(2)));
}

/** Everything after the newest assistant turn: where per-turn reminders are injected. */
function trailingText(turns: JsonRecord[]): string {
  const parts: string[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const role = turns[i]?.role;
    if (role === "assistant" || role === "model") break;
    parts.unshift(textOf(turns[i]?.content ?? turns[i]?.parts));
  }
  return parts.join("\n");
}

const includesAny = (text: string, sentinels: string[]) => sentinels.some((s) => text.includes(s));

/**
 * A delegated agent task whose content is encrypted (Codex subagents receive an
 * `agent_message` with an `encrypted_content` part). The decision model would only
 * see ciphertext, so routing falls back to the deterministic signals.
 */
export function isEncryptedTask(body: unknown): boolean {
  const turns = turnsOf(body) || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const item = asRecord(turns[i]);
    if (!item || isToolResultItem(item) || TOOL_CALL_TYPES.has(item.type as string)) continue;
    if (item.type !== "agent_message" || !Array.isArray(item.content)) return false;
    return item.content.some(
      (part) => asRecord(part)?.type === "encrypted_content" && asRecord(part)?.encrypted_content
    );
  }
  return false;
}

export type Signals = {
  housekeeping: boolean;
  planMode: boolean;
  stall: boolean;
  lastToolError: boolean;
  explicitThink: boolean;
  turnKind: "tool_continuation" | "human";
  humanTurns: number;
  userFeedback: string | null;
  frustration: number;
  humanText: string;
  contextTokens: number;
  hasMedia: boolean;
  toolCount: number;
  toolCalls: number;
  clientEffort: ReturnType<typeof extractThinking>;
  harnessSystem: boolean;
  encryptedTask: boolean;
};

/**
 * @param body raw client body (before translation)
 * @param ctx.hint parsed x-red-router-hint: its stall, feedback and
 *   frustration replace what the transcript regexes read.
 */
export function extractSignals(
  body: unknown,
  { userAgent = "", hint = null }: { userAgent?: string; hint?: JsonRecord | null } = {}
): Signals {
  const turns = turnsOf(body) || [];
  const b = asRecord(body) || {};
  const tools = Array.isArray(b.tools) ? (b.tools as JsonRecord[]) : [];
  const calls = toolCallsOf(body);
  const last = turns[turns.length - 1];
  const humanRaw = lastHumanRaw(turns);
  const recentText = trailingText(turns);
  const sys = systemText(body);

  const housekeeping =
    tools.length === 0 && includesAny(`${sys}\n${recentText}`, HOUSEKEEPING_SENTINELS);
  const planMode = includesAny(recentText, PLAN_MODE_SENTINELS);
  const humanText = stripHarnessNoise(humanRaw);
  const clientEffort = extractThinking(body);

  return {
    housekeeping,
    planMode,
    stall: typeof hint?.stall === "boolean" ? hint.stall : detectStall(calls),
    lastToolError: calls.length > 0 && calls[calls.length - 1].error,
    explicitThink: EXPLICIT_THINK_PATTERN.test(humanText),
    turnKind: isToolResultItem(last) ? "tool_continuation" : "human",
    // Human messages so far: with humanText it identifies the human turn a request belongs to.
    humanTurns: turns.filter(isHumanItem).length,
    userFeedback: typeof hint?.feedback === "string" ? hint.feedback : detectFeedback(humanText),
    frustration:
      typeof hint?.frustration === "number" ? hint.frustration : detectFrustration(humanText),
    humanText,
    contextTokens: estimateRequestTokens(body),
    hasMedia: [...detectRequiredCapabilities(body)].some(
      (cap) => cap === "vision" || cap === "pdf"
    ),
    toolCount: tools.length,
    toolCalls: calls.length,
    clientEffort: clientEffort || null,
    harnessSystem: HARNESS_SYSTEM_UA.test(userAgent || ""),
    encryptedTask: isEncryptedTask(body),
  };
}

/** The subset worth persisting next to a decision (no free text). */
export function signalsMeta(signals: Signals | null): Record<string, unknown> | null {
  if (!signals) return null;
  const { humanText: _humanText, clientEffort, ...rest } = signals;
  void _humanText;
  const effort = clientEffort as Record<string, unknown> | null;
  return { ...rest, clientEffort: effort?.level || effort?.mode || null };
}
