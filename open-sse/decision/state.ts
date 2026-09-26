// Builds the `state` jev is asked about, walking any message-shaped array the client
// sent rather than one adapter per source format.
//
// ponytail: generic and lossy, unrecognised shapes degrade to truncated JSON.
// Upgrade path: per-format extractors if the bench shows fidelity costs decisions.
//
// Ported 1:1 from the legacy fork (open-sse/decision/state.js @ c66f917c).

import { HARNESS_BLOCK_PATTERNS } from "../config/decisionSignals.ts";

const TRUNCATION_MARK = " …[truncated]… ";

type JsonRecord = Record<string, unknown>;
type Turn = JsonRecord;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

/** Drop harness-injected blocks (system reminders, environment context, AGENTS.md):
 *  they describe the agent harness, not the task the decision is about. */
export function stripHarnessNoise(text: unknown): string {
  if (typeof text !== "string" || !text) return text || "";
  let out = text;
  for (const pattern of HARNESS_BLOCK_PATTERNS) out = out.replace(pattern, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Head and tail; the middle of a long blob matters least. */
export function truncate(text: unknown, max: number): string {
  if (typeof text !== "string" || text.length <= max) return text || "";
  const keep = Math.max(0, max - TRUNCATION_MARK.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + TRUNCATION_MARK + text.slice(text.length - (keep - head));
}

/** jev is text-only: flatten parts, placeholder for anything else. */
export function textOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const p = asRecord(part);
        if (p && typeof p.text === "string") return p.text;
        if (p && typeof p.content === "string") return p.content;
        if (p && p.content && typeof p.content === "object") return textOf(p.content);
        return `[${(p?.type as string) || "attachment"}]`;
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const record = content as JsonRecord;
    if (typeof record.text === "string") return record.text;
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

/** The message-shaped array, whichever known shape the client used. */
export function turnsOf(body: unknown): Turn[] | null {
  const b = asRecord(body);
  if (!b) return null;
  if (Array.isArray(b.messages)) return b.messages as Turn[];
  if (Array.isArray(b.input)) {
    // OpenAI Responses: `instructions` carries the system text, input[] the turns.
    return b.input as Turn[];
  }
  if (Array.isArray(b.contents)) return b.contents as Turn[]; // Gemini
  if (Array.isArray(asRecord(b.conversation)?.messages))
    return asRecord(b.conversation)?.messages as Turn[];
  return null;
}

function systemTextOf(body: unknown): string {
  const b = asRecord(body) || {};
  const parts: string[] = [];
  if (typeof b.system === "string") parts.push(b.system);
  else if (Array.isArray(b.system)) parts.push(textOf(b.system));
  else if (b.system) parts.push(textOf(b.system));
  if (typeof b.instructions === "string") parts.push(b.instructions);
  if (typeof b.system_instruction === "string") parts.push(b.system_instruction);
  const sysConfig = asRecord(b.systemInstruction)?.parts || asRecord(b.system_instruction)?.parts;
  if (Array.isArray(sysConfig)) parts.push(textOf(sysConfig));
  return parts.filter(Boolean).join("\n\n");
}

export type StateEntry = {
  role: string;
  text: string;
  tool_calls?: { tool: string }[];
};

export type JevState = {
  assistant_instructions?: string;
  earlier_turns_omitted?: number;
  request?: string;
  conversation?: StateEntry[];
};

/**
 * @param body the client's body, before translation
 * @param opts.dropSystem omit the system prompt (harness boilerplate)
 */
export function buildState(
  body: unknown,
  { maxStateChars = 24000, maxMessageChars = 4000, dropSystem = false } = {}
): JevState {
  const systemText = dropSystem ? "" : truncate(systemTextOf(body), maxMessageChars);
  const turns = turnsOf(body);

  if (!turns) {
    // Unknown shape: a truncated picture rather than nothing.
    return { request: truncate(safeStringify(body), maxStateChars) };
  }

  const conversation: StateEntry[] = [];
  let budget = maxStateChars - systemText.length;
  // Newest first: the current task is what survives a spent budget.
  for (let i = turns.length - 1; i >= 0; i--) {
    const msg = asRecord(turns[i]);
    if (!msg) continue;
    const entry: StateEntry = {
      role: typeof msg.role === "string" ? msg.role : "user",
      text: truncate(stripHarnessNoise(textOf(msg.content) || textOf(msg.parts)), maxMessageChars),
    };
    const tools = Array.isArray(msg.tool_calls) ? (msg.tool_calls as JsonRecord[]) : null;
    if (tools?.length) {
      entry.tool_calls = tools.slice(0, 8).map((call) => ({
        tool: (asRecord(call?.function)?.name as string) || (call?.name as string) || "unknown",
      }));
    }
    if (msg.role === "tool" || msg.role === "function") {
      entry.role = "tool_result";
      entry.text = truncate(entry.text, 600);
    }
    budget -= JSON.stringify(entry).length;
    if (budget < 0 && conversation.length > 0) break;
    conversation.unshift(entry);
  }

  const omitted = turns.length - conversation.length;
  return {
    ...(systemText ? { assistant_instructions: systemText } : {}),
    ...(omitted > 0 ? { earlier_turns_omitted: omitted } : {}),
    conversation,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** True when the body carries an explicit cache breakpoint — the signal
 *  that mutating anything before the tail would cost a cache rewrite. */
export function hasCacheBreakpoint(body: unknown): boolean {
  const b = asRecord(body);
  if (!b) return false;
  if (b.cache_control) return true;
  const sys = b.system;
  if (Array.isArray(sys) && sys.some((x) => asRecord(x)?.cache_control)) return true;
  const tools = b.tools;
  if (Array.isArray(tools) && tools.some((x) => asRecord(x)?.cache_control)) return true;
  const msgs = turnsOf(body);
  if (msgs) {
    for (const msg of msgs) {
      const m = asRecord(msg);
      if (!m) continue;
      if (m.cache_control) return true;
      if (Array.isArray(m.content) && m.content.some((x) => asRecord(x)?.cache_control))
        return true;
    }
  }
  return false;
}
