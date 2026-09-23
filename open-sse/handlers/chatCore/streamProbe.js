import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { sanitizePublicMessage } from "../../utils/error.js";

// Upstreams sometimes answer HTTP 200 and then fail inside the stream: an error
// event, `choices: null`, a role-only chunk and EOF, or a finish_reason that is
// really an error. Once the client has the 200 there is no fallback left, so the
// stream is read ahead until its first event that carries an answer (content,
// reasoning, a tool call, a stop) and a failure before that point becomes an
// ordinary error result. Unknown event shapes count as an answer: fail-open.

const QUOTA_PATTERN = /rate[ _-]?limit|too many requests|quota|usage[_ -]?limit|spend(ing)? limit|insufficient (balance|credits?)/i;
const OVERLOAD_PATTERN = /overload|capacity|temporarily unavailable|try again later/i;

// finish_reason values that are errors, not answers.
const CONTEXT_FINISH_REASONS = new Set(["model_context_window_exceeded", "context_length_exceeded"]);
const ERROR_FINISH_REASONS = new Set(["error"]);

// Events that open a stream without answering anything yet.
const CLAUDE_PREAMBLE = new Set(["message_start", "ping", "content_block_stop"]);
const RESPONSES_PREAMBLE = new Set(["response.created", "response.in_progress", "response.queued", "response.content_part.added"]);

const nonEmpty = (value) => typeof value === "string" ? value.length > 0 : Array.isArray(value) ? value.length > 0 : value != null;

function errorStatus(error, message) {
  const code = Number(error?.code ?? error?.status ?? error?.status_code);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  if (QUOTA_PATTERN.test(message)) return HTTP_STATUS.RATE_LIMITED;
  if (OVERLOAD_PATTERN.test(message)) return HTTP_STATUS.SERVICE_UNAVAILABLE;
  return HTTP_STATUS.BAD_GATEWAY;
}

function failure(error, fallbackMessage) {
  const raw = typeof error === "string" ? error : error?.message || error?.error?.message || error?.type;
  const message = sanitizePublicMessage(raw, fallbackMessage);
  return { kind: "error", statusCode: errorStatus(typeof error === "object" ? error : null, String(raw || "")), message };
}

function classifyOpenAIChunk(json) {
  if (!Array.isArray(json.choices) || json.choices.length === 0) return { kind: "pending" };
  for (const choice of json.choices) {
    const delta = choice?.delta || choice?.message || {};
    if (nonEmpty(delta.content) || nonEmpty(delta.reasoning_content) || nonEmpty(delta.reasoning)
      || nonEmpty(delta.tool_calls) || delta.function_call || nonEmpty(delta.refusal) || nonEmpty(choice?.text)) {
      return { kind: "answer" };
    }
    const finish = choice?.finish_reason;
    if (finish) {
      if (CONTEXT_FINISH_REASONS.has(finish)) {
        return { kind: "error", statusCode: HTTP_STATUS.BAD_REQUEST, message: `Upstream context window exceeded (${finish})` };
      }
      if (ERROR_FINISH_REASONS.has(finish)) return failure(json.error || "Upstream stream finished with an error", "Upstream stream finished with an error");
      return { kind: "answer" };
    }
  }
  return { kind: "pending" };
}

function classifyClaudeEvent(json) {
  if (CLAUDE_PREAMBLE.has(json.type)) return { kind: "pending" };
  if (json.type === "content_block_start") {
    const block = json.content_block || {};
    if ((block.type === "text" && !block.text) || (block.type === "thinking" && !block.thinking)) return { kind: "pending" };
    return { kind: "answer" };
  }
  if (json.type === "content_block_delta") {
    const d = json.delta || {};
    return nonEmpty(d.text) || nonEmpty(d.thinking) || nonEmpty(d.partial_json) || nonEmpty(d.signature) ? { kind: "answer" } : { kind: "pending" };
  }
  return { kind: "answer" };
}

function classifyGeminiChunk(json) {
  if (json.promptFeedback?.blockReason) return { kind: "answer" };
  for (const candidate of json.candidates || []) {
    if ((candidate?.content?.parts || []).some((p) => nonEmpty(p?.text) || p?.functionCall || p?.thought)) return { kind: "answer" };
    if (candidate?.finishReason) return { kind: "answer" };
  }
  return { kind: "pending" };
}

/** What one SSE event says about the stream: "pending", "answer", "error" or "done". */
export function classifyStreamEvent({ event = null, data = "" }) {
  const payload = data.trim();
  if (!payload) return { kind: "pending" };
  if (payload === "[DONE]") return { kind: "done" };
  let json;
  try { json = JSON.parse(payload); } catch { return { kind: "answer" }; }
  if (!json || typeof json !== "object") return { kind: "answer" };

  if (event === "error" || json.type === "error") return failure(json.error || json, "Upstream stream returned an error");
  if (json.type === "response.failed") return failure(json.response?.error || "Upstream response failed", "Upstream response failed");
  if (json.error && !json.choices && !json.candidates) return failure(json.error, "Upstream stream returned an error");

  if ("choices" in json) return classifyOpenAIChunk(json);
  if (typeof json.type === "string" && json.type.startsWith("response.")) {
    if (RESPONSES_PREAMBLE.has(json.type)) return { kind: "pending" };
    if (json.type === "response.output_item.added" && json.item?.type === "message") return { kind: "pending" };
    return { kind: "answer" };
  }
  if (typeof json.type === "string") return classifyClaudeEvent(json);
  if ("candidates" in json || "promptFeedback" in json) return classifyGeminiChunk(json);
  return { kind: "answer" };
}

/**
 * Incremental SSE reader: feed decoded text, get the stream's verdict so far —
 * "answer" (release it), "error" (fail it), or "pending" (keep reading).
 */
export function createStreamProbe() {
  let buffer = "";
  return {
    push(text) {
      buffer += text.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = null;
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        const verdict = classifyStreamEvent({ event, data: data.join("\n") });
        if (verdict.kind === "answer" || verdict.kind === "error") return verdict;
      }
      return { kind: "pending" };
    },
  };
}

/** Whether the first bytes of a body look like SSE text (binary framings are not probed). */
export function looksLikeSSE(text) {
  return /^\s*(data|event|id|retry)?:/.test(text);
}

/**
 * The same check for a complete non-streaming body: null when it is an answer,
 * else { statusCode, message } for a failure that arrived with HTTP 200.
 */
export function nonStreamFailure(body) {
  if (!body || typeof body !== "object") return null;
  if (body.type === "error") return failure(body.error || body, "Upstream returned an error");
  if (body.object === "response" && body.status === "failed") return failure(body.error || "Upstream response failed", "Upstream response failed");
  const answered = body.choices || body.candidates || body.content || body.output || body.message;
  if (body.error && !answered) return failure(body.error, "Upstream returned an error");
  if ("choices" in body && (!Array.isArray(body.choices) || body.choices.length === 0)) {
    return { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream returned no choices" };
  }
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      const content = choice?.message?.content;
      const empty = !nonEmpty(content) && !nonEmpty(choice?.message?.tool_calls);
      if (empty && CONTEXT_FINISH_REASONS.has(choice?.finish_reason)) {
        return { statusCode: HTTP_STATUS.BAD_REQUEST, message: `Upstream context window exceeded (${choice.finish_reason})` };
      }
      if (empty && ERROR_FINISH_REASONS.has(choice?.finish_reason)) {
        return failure(body.error || "Upstream finished with an error", "Upstream finished with an error");
      }
    }
  }
  return null;
}
