import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import { safeParseJSON } from "../helpers/jsonUtil.ts";

/**
 * OpenAI request -> Ollama native /api/chat envelope.
 *
 * Ollama expects:
 * - messages: Array<{ role, content: string, images?: string[] }>
 * - options: { temperature, num_predict, top_p }
 * - tools/tool_choice in OpenAI shape (Ollama accepts them natively)
 *
 * Ported from the legacy RedRouter fork (openai-to-ollama.js).
 */

function parseDataUri(uri: string): { base64: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(uri);
  if (!match || !match[3]) return null;
  return { base64: match[3] };
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (block: Record<string, unknown>) =>
          block && block.type === "text" && typeof block.text === "string"
      )
      .map((block: Record<string, unknown>) => block.text as string);
    return textParts.join("\n") || "";
  }
  return "";
}

function extractImagesFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (!b || b.type !== "image_url") continue;
    const imageUrl = b.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : ((imageUrl as Record<string, unknown>)?.url as string);
    if (typeof url !== "string" || !url) continue;
    const parsed = parseDataUri(url);
    if (!parsed) continue;
    images.push(parsed.base64);
  }
  return images;
}

function normalizeMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return messages;
  const result: unknown[] = [];
  const toolCallMap = new Map<string, string>();

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (typeof tc.id === "string" && fn?.name) {
          toolCallMap.set(tc.id, fn.name as string);
        }
      }
    }
  }

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;

    if (m.role === "tool") {
      const toolResult = normalizeContent(m.content);
      if (!toolResult) continue;
      const toolName =
        (typeof m.tool_call_id === "string" && toolCallMap.get(m.tool_call_id)) ||
        (m.name as string) ||
        "unknown_tool";
      result.push({ role: "tool", tool_name: toolName, content: toolResult });
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const content = normalizeContent(m.content) || "";
      const ollamaToolCalls = (m.tool_calls as Array<Record<string, unknown>>).map((tc) => {
        const fn = tc.function as Record<string, unknown> | undefined;
        const rawArgs = fn?.arguments;
        return {
          function: {
            index: (tc.index as number) || 0,
            name: fn?.name || "",
            arguments:
              typeof rawArgs === "string" ? safeParseJSON(rawArgs || "{}", {}) : rawArgs || {},
          },
        };
      });
      result.push({ role: "assistant", content, tool_calls: ollamaToolCalls });
      continue;
    }

    const role = m.role;
    const content = normalizeContent(m.content);
    const images = extractImagesFromContent(m.content);
    if (!content && role !== "assistant") continue;

    const out: Record<string, unknown> = { role, content };
    if (images.length > 0) out.images = images;
    result.push(out);
  }

  return result;
}

export function openaiToOllamaRequest(
  model: string,
  body: Record<string, unknown>,
  _stream: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model,
    messages: normalizeMessages(body.messages),
    stream: false,
  };

  const options: Record<string, unknown> = {};
  if (body.temperature !== undefined) options.temperature = body.temperature;
  if (body.max_tokens !== undefined) options.num_predict = body.max_tokens;
  if (body.top_p !== undefined) options.top_p = body.top_p;
  if (Object.keys(options).length > 0) result.options = options;

  if (Array.isArray(body.tools)) result.tools = body.tools;
  if (body.tool_choice) result.tool_choice = body.tool_choice;

  return result;
}

register(FORMATS.OPENAI, FORMATS.OLLAMA, openaiToOllamaRequest, null);
