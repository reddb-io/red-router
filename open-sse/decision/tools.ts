// Reads the tool roster from the body already translated to the target format. The
// names jev picks go back into `tool_choice`, which addresses the names the upstream
// sees — not the client's, which `_toolNameMap` reconciles and chatCore then deletes.
//
// Ported 1:1 from the legacy fork (open-sse/decision/tools.js @ c66f917c).

import { FORMATS } from "../translator/formats.ts";

type JsonRecord = Record<string, unknown>;

/** Binary/NDJSON upstreams never reach the translator, so there is no tool_choice to
 *  write. Auto-combo is unaffected — it only changes `model`. */
export const UNSUPPORTED_EXECUTORS = new Set([
  "kiro",
  "cursor",
  "commandcode",
  "windsurf",
  "devin-cli",
  "zed",
]);

export type ExtractedTool = { name: string; description?: string; kind: "function" | "hosted" };

/**
 * TODO(fork-port): the legacy fork also matched FORMATS.GEMINI_CLI / FORMATS.VERTEX /
 * FORMATS.BEDROCK_CONVERSE — those format ids do not exist in this base's
 * translator/formats.ts yet. GEMINI and ANTIGRAVITY carry the same nested roster.
 */
export function extractTools(body: unknown, format: string): ExtractedTool[] {
  if (!body || typeof body !== "object") return [];
  const b = body as JsonRecord;

  // Gemini / Antigravity carry the roster nested under a tool object.
  if (isGemini(format)) {
    const decls: JsonRecord[] = [];
    for (const tool of asArray(b.tools)) {
      for (const fn of asArray(asRecord(tool)?.functionDeclarations)) decls.push(fn);
    }
    return decls
      .filter((fn) => typeof fn?.name === "string")
      .map((fn) => ({
        name: fn.name as string,
        description: fn.description as string | undefined,
        kind: "function" as const,
      }));
  }

  const out: ExtractedTool[] = [];
  const hosted = new Set<string>();
  for (const tool of asArray(b.tools)) {
    const t = asRecord(tool);
    // Anthropic: a versioned `type` (web_search_20250305) is provider-run and
    // cannot be forced by name; "custom" or absent is a client tool.
    const type = t?.type;
    if (typeof type === "string" && type !== "function" && type !== "custom") {
      if (hosted.has(type)) continue; // the same built-in listed twice is one option
      hosted.add(type);
      out.push({
        name: (t?.name as string) || type,
        description: t?.description as string | undefined,
        kind: "hosted",
      });
      continue;
    }
    if (typeof t?.name === "string") {
      out.push({
        name: t.name as string,
        description: t.description as string | undefined,
        kind: "function",
      });
      continue;
    }
    const fn = asRecord(t?.function);
    if (typeof fn?.name === "string") {
      out.push({
        name: fn.name as string,
        description: fn.description as string | undefined,
        kind: "function",
      });
      continue;
    }
    const custom = asRecord(t?.custom);
    if (typeof custom?.name === "string") {
      out.push({
        name: custom.name as string,
        description: custom.description as string | undefined,
        kind: "hosted",
      });
    }
  }
  return out;
}

export function isGemini(format: string): boolean {
  return (
    format === FORMATS.GEMINI ||
    // TODO(fork-port): legacy FORMATS.GEMINI_CLI / FORMATS.VERTEX do not exist here.
    format === FORMATS.ANTIGRAVITY
  );
}

/** Formats where writing `tool_choice` works. */
export function supportsToolChoice(format: string): boolean {
  return (
    format === FORMATS.OPENAI ||
    format === FORMATS.OPENAI_RESPONSES ||
    format === FORMATS.OPENAI_RESPONSE ||
    format === FORMATS.CLAUDE ||
    // TODO(fork-port): legacy FORMATS.BEDROCK_CONVERSE does not exist in this base.
    format === FORMATS.OLLAMA
  );
}

/** Writes the decision into the target body. Returns true when it changed. */
export function applyToolChoice(body: unknown, format: string, decision: unknown): boolean {
  const b = body as JsonRecord | null;
  if (!b || typeof b !== "object" || !decision) return false;
  if (hasPinnedToolChoice(b, format)) return false;
  try {
    const d = decision as { mode?: string; tool?: string };
    if (d.mode === "none") {
      if (format === FORMATS.CLAUDE) b.tool_choice = { type: "none" };
      else b.tool_choice = "none";
      return true;
    }
    if (d.mode === "forced") {
      if (format === FORMATS.CLAUDE) b.tool_choice = { type: "tool", name: d.tool };
      else if (format === FORMATS.OPENAI_RESPONSES || format === FORMATS.OPENAI_RESPONSE) {
        b.tool_choice = { type: "function", name: d.tool };
      } else b.tool_choice = { type: "function", function: { name: d.tool } };
      return true;
    }
  } catch {
    // A decision is an optimisation; never let it break the request.
  }
  return false;
}

/** A caller's explicit prohibition or pin has higher authority than the router.
 *  TODO(fork-port): the legacy check also exempted Bedrock Converse's toolConfig.toolChoice,
 *  a format that does not exist in this base — the param is kept for signature parity. */
export function hasPinnedToolChoice(body: unknown, _format: string): boolean {
  const b = body as JsonRecord | null;
  if (!b) return false;
  const choice = b.tool_choice;
  if (choice == null || choice === "auto") return false;
  if (typeof choice === "object" && (choice as JsonRecord).type === "auto") return false;
  return true;
}

const asArray = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? (value as JsonRecord[]) : [];
const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
