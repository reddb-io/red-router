/**
 * JEV tool decision — additive port from the legacy fork (chatCore.js @ c66f917c,
 * lines ~400-427 + buildDecisionDetail from chatCore/requestDetail.js).
 *
 * Wired additively in handleChatCore: inert unless the caller supplies `decideTool`
 * (a callback that asks the System One decision model which tool to force). The
 * default path never constructs it, so the request behavior is byte-identical.
 */

import { injectHint } from "../../decision/injectHint.ts";
import { applyToolChoice } from "../../decision/tools.ts";
import { DECISION_HEADER, HINT_SOURCE, decisionOptOut } from "../../decision/clientHint.ts";
import { getHeaderValueCaseInsensitive } from "./headers.ts";

type JsonRecord = Record<string, unknown>;

type LogLike =
  { warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void } | null | undefined;

export type ToolDecisionVerdict = {
  mode?: string;
  tool?: string;
  reason?: string;
  confidence?: number;
  latencyMs?: number;
  source?: string;
} | null;

type DecideToolFn = (args: {
  body: JsonRecord;
  format: string;
  provider: string;
  model: string;
}) => Promise<ToolDecisionVerdict> | ToolDecisionVerdict;

const num = (v: unknown): number | null => (typeof v === "number" ? Number(v.toFixed(3)) : null);

/**
 * What a request's detail row records about the decision engine's inputs: the model
 * decision, the tool decision, the client hint and the reasoning autopilot result.
 * Ported 1:1 from the legacy chatCore/requestDetail.js buildDecisionDetail.
 */
export function buildDecisionDetail(
  modelDecision: JsonRecord | null,
  toolDecision: ToolDecisionVerdict,
  hint: JsonRecord | null = null,
  reasoning: JsonRecord | null = null
): JsonRecord | undefined {
  const parts: JsonRecord = {};
  const r = reasoning as {
    level?: unknown;
    from?: unknown;
    cause?: unknown;
    target?: unknown;
    deliberation?: unknown;
  } | null;
  if (r?.level) {
    parts.reasoning = {
      level: r.level,
      from: r.from || null,
      cause: r.cause || null,
      applied: !!r.target,
      deliberation: num(r.deliberation),
    };
  }
  const md = modelDecision as {
    model?: unknown;
    apply?: unknown;
    reason?: unknown;
    confidence?: unknown;
    deliberation?: unknown;
    deliberationSource?: unknown;
  } | null;
  if (modelDecision) {
    parts.model = {
      chosen: md.model || null,
      applied: md.apply === true,
      reason: md.reason || null,
      confidence: num(md.confidence),
      deliberation: num(md.deliberation),
      ...(md.deliberationSource ? { deliberation_source: md.deliberationSource } : {}),
    };
  }
  if (toolDecision) {
    parts.tool = {
      mode: toolDecision.mode || null,
      tool: toolDecision.tool || null,
      reason: toolDecision.reason || null,
      confidence: num(toolDecision.confidence),
      latencyMs: num(toolDecision.latencyMs),
    };
  }
  // A classification the client sent (x-red-router-hint), and what it replaced.
  if (hint) parts.hint = hint;
  return Object.keys(parts).length ? parts : undefined;
}

/**
 * Ask the decision callback which tool the upstream should call next, apply its
 * verdict to the translated body (tool_choice pin or trailing hint) and build the
 * decision detail row. Fail-open: any error only skips the optimization.
 *
 * @returns {{ toolDecision, decisionDetail, logLine }} logLine is the `xf`
 *   accumulator entry the legacy fork pushed onto its "⚙" trace line.
 */
export async function applyToolDecision(
  translatedBody: JsonRecord,
  {
    decideTool,
    format,
    provider,
    model,
    clientRawRequest,
    decision = null,
    hint = null,
    reasoning = null,
    log,
  }: {
    decideTool: unknown;
    format: string;
    provider: string;
    model: string;
    clientRawRequest?: { headers?: unknown } | null;
    decision?: JsonRecord | null;
    hint?: JsonRecord | null;
    reasoning?: JsonRecord | null;
    log?: LogLike;
  }
): Promise<{
  toolDecision: ToolDecisionVerdict;
  decisionDetail: JsonRecord | undefined;
  logLine: string | null;
}> {
  let toolDecision: ToolDecisionVerdict = null;
  const decisionHeader = getHeaderValueCaseInsensitive(
    (clientRawRequest?.headers as JsonRecord | Headers | null | undefined) ?? null,
    DECISION_HEADER
  );
  if (typeof decideTool === "function" && !decisionOptOut(decisionHeader).tools) {
    try {
      const result = await (decideTool as DecideToolFn)({
        body: translatedBody,
        format,
        provider,
        model,
      });
      toolDecision = result || null;
      if (result?.mode && result.mode !== "passthrough") {
        const applied =
          result.mode === "hint"
            ? injectHint(translatedBody, format, result.tool)
            : applyToolChoice(translatedBody, format, result);
        return {
          toolDecision,
          decisionDetail: undefined,
          logLine: `DECISION:${result.mode}:${result.tool || "-"}:${applied ? "applied" : "noop"}`,
        };
      }
      if (result) {
        return {
          toolDecision,
          decisionDetail: undefined,
          logLine: `DECISION:skip:${result.reason || "-"}`,
        };
      }
    } catch (error) {
      log?.warn?.(
        "DECISION",
        `tool decision failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  // The tool step is the last one a client hint can replace; it is known only here.
  const hintRecord =
    hint && toolDecision?.source === HINT_SOURCE
      ? {
          ...hint,
          used_for: [...new Set([...((hint.used_for as string[]) || []), "needs_tool"])],
        }
      : hint;
  const decisionDetail =
    decision || toolDecision || hintRecord || reasoning
      ? buildDecisionDetail(decision, toolDecision, hintRecord, reasoning)
      : undefined;
  return { toolDecision, decisionDetail, logLine: null };
}
