// Appends a routing hint at the very end of the conversation. Fails open.
//
// Deliberately not the RTK system injector: that one splices before the last
// cache_control, correct for the stable caveman/ponytail prompts but wrong for a
// hint, which names this turn's tool and would rewrite the cached prefix every
// request. Appending after the breakpoints leaves the prefix byte-identical.
//
// Ported 1:1 from the legacy fork (open-sse/decision/injectHint.js @ c66f917c).

import { FORMATS } from "../translator/formats.ts";

type JsonRecord = Record<string, unknown>;

const SEP = "\n\n";

/** One inert token, nothing to break out of the reminder with. */
const SAFE_NAME = /^[\p{L}\p{N}_.:/-]{1,128}$/u;

export function hintText(tool: unknown): string | null {
  if (typeof tool !== "string" || !SAFE_NAME.test(tool)) return null;
  return (
    `<system-reminder>A tool-routing model suggests the "${tool}" tool is the most ` +
    `relevant next step. Ignore this if it does not fit what the user actually asked for.` +
    `</system-reminder>`
  );
}

/** @returns whether the body changed */
export function injectHint(body: unknown, format: string, tool: unknown): boolean {
  const text = hintText(tool);
  const b = body as JsonRecord | null;
  if (!text || !b || typeof b !== "object") return false;
  try {
    if (isGeminiFormat(format)) {
      return pushGemini(b, text);
    }
    if (Array.isArray(b.contents)) return pushGemini(b, text);
    if (Array.isArray(b.input)) return pushResponses(b.input as JsonRecord[], text);
    if (Array.isArray(b.messages)) return pushMessages(b.messages as JsonRecord[], text);
  } catch {
    // A hint is an optimisation; never let it break the request.
  }
  return false;
}

export { SEP };

const isGeminiFormat = (format: string): boolean =>
  format === FORMATS.GEMINI ||
  // TODO(fork-port): legacy FORMATS.GEMINI_CLI / FORMATS.VERTEX do not exist in this base.
  format === FORMATS.ANTIGRAVITY;

const lastUser = (messages: JsonRecord[]): JsonRecord | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user") return messages[i];
  }
  return null;
};

function alreadyHas(content: unknown, text: string): boolean {
  if (typeof content === "string") return content.includes(text);
  if (Array.isArray(content))
    return content.some(
      (block: unknown) =>
        block &&
        typeof (block as JsonRecord).text === "string" &&
        (block as JsonRecord).text.includes(text)
    );
  return false;
}

/** OpenAI chat and Claude Messages share the {role, content} shape. */
function pushMessages(messages: JsonRecord[], text: string): boolean {
  const target = lastUser(messages);
  if (!target || alreadyHas(target.content, text)) return false;
  if (typeof target.content === "string") {
    if (!target.content) return false;
    target.content = [
      { type: "text", text: target.content },
      { type: "text", text },
    ];
  } else if (Array.isArray(target.content)) {
    target.content.push({ type: "text", text });
  } else {
    return false;
  }
  // The hint has to land after any trailing cache breakpoint, which pushing already
  // guarantees.
  return true;
}

/** OpenAI Responses: input[] of items, the last user message typed. */
function pushResponses(input: JsonRecord[], text: string): boolean {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || item.role !== "user") continue;
    if (alreadyHas(item.content, text)) return false;
    if (typeof item.content === "string") {
      if (!item.content) return false;
      item.content = [
        { type: "input_text", text: item.content },
        { type: "input_text", text },
      ];
      return true;
    }
    if (Array.isArray(item.content)) {
      item.content.push({ type: "input_text", text });
      return true;
    }
    return false;
  }
  return false;
}

/** Gemini / Antigravity: contents[] with parts[]. */
function pushGemini(body: JsonRecord, text: string): boolean {
  const contents = Array.isArray(body.contents) ? (body.contents as JsonRecord[]) : null;
  if (!contents || contents.length === 0) return false;
  const last = contents[contents.length - 1];
  const parts = Array.isArray(last?.parts) ? (last.parts as JsonRecord[]) : null;
  if (!parts) return false;
  if (parts.some((p) => p && typeof p.text === "string" && p.text.includes(text))) return false;
  parts.push({ text });
  return true;
}
