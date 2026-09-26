import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import { fallbackToolCallId } from "../helpers/toolCallHelper.ts";

/**
 * Ollama native NDJSON -> OpenAI chunk translation.
 *
 * Ollama chunk: {"model": "...", "message": {"role": "assistant", "content": "..."}, "done": false}
 * Final chunk:  {"model": "...", "done": true, "prompt_eval_count": N, "eval_count": N}
 *
 * Ported from the legacy RedRouter fork (ollama-to-openai.js).
 */

function convertToolCalls(toolCalls: Array<Record<string, unknown>>) {
  return toolCalls.map((tc, i) => {
    const fn = tc.function as Record<string, unknown> | undefined;
    const rawArgs = fn?.arguments;
    return {
      index: (fn?.index as number) ?? i,
      id: (tc.id as string) || fallbackToolCallId(i),
      type: "function",
      function: {
        name: fn?.name || "",
        arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs || {}),
      },
    };
  });
}

function extractUsage(body: Record<string, unknown>): Record<string, number> | undefined {
  const prompt = body.prompt_eval_count;
  const completion = body.eval_count;
  if (typeof prompt !== "number" && typeof completion !== "number") return undefined;
  return {
    ...(typeof prompt === "number" ? { prompt_tokens: prompt } : {}),
    ...(typeof completion === "number" ? { completion_tokens: completion } : {}),
    ...(typeof prompt === "number" && typeof completion === "number"
      ? { total_tokens: prompt + completion }
      : {}),
  };
}

export function ollamaToOpenAIResponse(
  chunk: unknown,
  state: Record<string, unknown>
): Record<string, unknown> | null {
  if (!chunk || typeof chunk !== "object") return null;
  const c = chunk as Record<string, unknown>;

  if (!state.ollama) {
    state.ollama = {
      id: `chatcmpl-${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      model: c.model || state.model,
    };
  }
  const meta = state.ollama as Record<string, unknown>;
  const { id, created, model } = meta;

  if (c.done) {
    const usage = extractUsage(c);
    let finishReason = "stop";
    if (c.done_reason === "tool_calls" || state.hadToolCalls) {
      finishReason = "tool_calls";
    }
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  }

  const message = c.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = typeof message.content === "string" ? message.content : "";
  const thinking = typeof message.thinking === "string" ? message.thinking : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<Record<string, unknown>>)
    : null;

  if (!content && !thinking && !toolCalls) return null;

  if (content) {
    state.accumulatedContent = (state.accumulatedContent || "") + content;
  }
  if (thinking) {
    state.accumulatedThinking = (state.accumulatedThinking || "") + thinking;
  }

  const delta: Record<string, unknown> = {};
  if (content) delta.content = content;
  if (thinking) delta.reasoning_content = thinking;
  if (toolCalls) {
    state.hadToolCalls = true;
    delta.tool_calls = convertToolCalls(toolCalls);
  }

  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

/** Ollama non-streaming body -> OpenAI chat.completion (for stream:false upstreams). */
export function ollamaBodyToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const msg = (body.message as Record<string, unknown>) || {};
  const content = (msg.content as string) || "";
  const thinking = (msg.thinking as string) || "";
  const toolCalls = Array.isArray(msg.tool_calls)
    ? (msg.tool_calls as Array<Record<string, unknown>>)
    : [];

  const message: Record<string, unknown> = { role: "assistant" };
  if (content) message.content = content;
  if (thinking) message.reasoning_content = thinking;
  if (toolCalls.length > 0) message.tool_calls = convertToolCalls(toolCalls);
  if (!message.content && !message.tool_calls) message.content = "";

  let finishReason = "stop";
  if (toolCalls.length > 0) finishReason = "tool_calls";

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "ollama",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(extractUsage(body) ? { usage: extractUsage(body) } : {}),
  };
}

register(FORMATS.OLLAMA, FORMATS.OPENAI, null, ollamaToOpenAIResponse);
