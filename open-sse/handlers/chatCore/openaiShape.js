import { FORMATS } from "../../translator/formats.js";

// Fields OpenAI's schemas require on a JSON answer that translated upstreams
// (Claude, Gemini, …) do not produce: filled with the neutral value OpenAI itself
// sends, so strict clients and schema validators accept every answer. Only the
// OpenAI client formats are touched; values already present are kept.
// Checked by tests/unit/openai-conformance.test.js against OpenAI's OpenAPI spec.

/** Chat Completions: each choice needs `logprobs`, each message `content` and `refusal`. */
export function conformChatCompletion(body) {
  if (!body || body.object !== "chat.completion" || !Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    if (!choice || typeof choice !== "object") continue;
    if (choice.logprobs === undefined) choice.logprobs = null;
    const message = choice.message;
    if (message && typeof message === "object") {
      if (message.role === undefined) message.role = "assistant";
      if (message.content === undefined) message.content = null;
      if (message.refusal === undefined) message.refusal = null;
    }
  }
  return body;
}

let itemSeq = 0;
const itemId = (prefix) => `${prefix}_${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

/**
 * Responses API: the request settings the answer echoes (instructions, tools,
 * tool_choice, sampling, metadata), `error`/`incomplete_details`, output item ids
 * and statuses, `annotations` on text, and the usage detail blocks.
 */
export function conformResponse(body, request = {}) {
  if (!body || body.object !== "response") return body;
  const req = request && typeof request === "object" ? request : {};
  if (!body.id) body.id = itemId("resp");
  if (!Number.isFinite(body.created_at)) body.created_at = Math.floor(Date.now() / 1000);
  if (body.error === undefined) body.error = null;
  if (body.incomplete_details === undefined) body.incomplete_details = null;
  if (body.instructions === undefined) body.instructions = typeof req.instructions === "string" ? req.instructions : null;
  if (!Array.isArray(body.tools)) body.tools = Array.isArray(req.tools) ? req.tools : [];
  if (body.tool_choice === undefined) body.tool_choice = req.tool_choice ?? "auto";
  if (typeof body.parallel_tool_calls !== "boolean") body.parallel_tool_calls = req.parallel_tool_calls !== false;
  if (body.metadata === undefined) body.metadata = req.metadata && typeof req.metadata === "object" ? req.metadata : {};
  if (body.temperature === undefined) body.temperature = Number.isFinite(req.temperature) ? req.temperature : null;
  if (body.top_p === undefined) body.top_p = Number.isFinite(req.top_p) ? req.top_p : null;
  if (!Array.isArray(body.output)) body.output = [];
  for (const item of body.output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      if (!item.id) item.id = itemId("msg");
      if (!item.status) item.status = "completed";
      if (!item.role) item.role = "assistant";
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && !Array.isArray(part.annotations)) part.annotations = [];
      }
    } else if (item.type === "function_call") {
      if (!item.id) item.id = itemId("fc");
      if (!item.status) item.status = "completed";
    } else if (item.type === "reasoning") {
      if (!item.id) item.id = itemId("rs");
      if (!Array.isArray(item.summary)) item.summary = [];
    }
  }
  const usage = body.usage;
  if (usage && typeof usage === "object") {
    usage.input_tokens ??= 0;
    usage.output_tokens ??= 0;
    usage.total_tokens ??= usage.input_tokens + usage.output_tokens;
    usage.input_tokens_details = { cached_tokens: 0, ...(usage.input_tokens_details || {}) };
    usage.output_tokens_details = { reasoning_tokens: 0, ...(usage.output_tokens_details || {}) };
  }
  return body;
}

/** The JSON answer for an OpenAI-format client, completed to OpenAI's schema. */
export function conformForClient(body, sourceFormat, request) {
  if (sourceFormat === FORMATS.OPENAI) return conformChatCompletion(body);
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return conformResponse(body, request);
  return body;
}
