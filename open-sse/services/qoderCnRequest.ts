import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

const ContentPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const MessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  })
  .passthrough();
const ChatBodySchema = z
  .object({
    messages: z.array(MessageSchema).min(1).max(512),
    tools: z.array(z.unknown()).max(128).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

type JsonRecord = Record<string, unknown>;

function normalizeContent(content: unknown): string | JsonRecord[] {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Qoder CN message content is invalid");
  const parts: JsonRecord[] = [];
  let hasImage = false;
  for (const part of content) {
    const parsed = ContentPartSchema.safeParse(part);
    if (parsed.success) {
      parts.push({ type: "text", text: parsed.data.text });
      continue;
    }
    const image = part !== null && typeof part === "object" ? (part as JsonRecord) : null;
    const imageUrl = image?.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl !== null && typeof imageUrl === "object"
          ? (imageUrl as JsonRecord).url
          : undefined;
    if (image?.type !== "image_url" || typeof url !== "string") {
      throw new Error("Qoder CN message contains an unsupported attachment");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Qoder CN message contains an invalid image URL");
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      throw new Error("Qoder CN message contains an invalid image URL");
    }
    parts.push({ type: "image_url", image_url: { url } });
    hasImage = true;
  }
  return hasImage ? parts : parts.map((part) => part.text).join("\n");
}

function stableHash(prefix: string, ...parts: unknown[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(typeof part === "string" ? part : JSON.stringify(part) || "");
  }
  return hash.digest("hex").slice(0, 16);
}

function tierTokenCount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== "string") return 0;
  const match = value
    .trim()
    .toUpperCase()
    .match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
  if (!match) return 0;
  const count = Number(match[1]) * (match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function contextTier(config: JsonRecord, system: string, messages: JsonRecord[], tools: unknown[]) {
  if (!Array.isArray(config.context_config)) return null;
  const current = tierTokenCount(config.max_input_tokens);
  const tiers = config.context_config
    .filter((item): item is JsonRecord => item !== null && typeof item === "object")
    .map((item) => tierTokenCount(item.tokenCount ?? item.token_count ?? item.max_input_tokens))
    .filter((value) => value > current)
    .sort((a, b) => a - b);
  if (tiers.length === 0) return null;
  const prompt = JSON.stringify({ system, messages, tools });
  const cjk = (
    prompt.match(/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g) || []
  ).length;
  const estimate = Math.ceil(cjk + (prompt.length - cjk) / 4);
  const required = Math.ceil(estimate * 1.15);
  if (required <= current) return null;
  return tiers.find((value) => value >= required) || tiers[tiers.length - 1];
}

/** Build the CN agent-chat payload from OpenAI chat input and live model_config. */
export function buildQoderCnRequest(
  modelKey: string,
  body: unknown,
  modelConfig: JsonRecord,
  userId: string
): { payload: JsonRecord; plaintext: Uint8Array } {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success || !modelKey || !userId || modelConfig.key !== modelKey) {
    throw new Error("Qoder CN chat request or model config is invalid");
  }

  const systemParts: string[] = [];
  const messages: JsonRecord[] = [];
  for (const message of parsed.data.messages) {
    const content = normalizeContent(message.content);
    if (message.role === "system") {
      if (typeof content !== "string") throw new Error("Qoder CN system images are unsupported");
      if (content) systemParts.push(content);
    } else {
      messages.push({ ...message, content });
    }
  }
  if (messages.length === 0) throw new Error("Qoder CN chat requires a non-system message");

  const system = systemParts.join("\n\n");
  const tools = parsed.data.tools || [];
  const outputLimit = Number(modelConfig.max_output_tokens) || 32_768;
  const maxTokens = Math.min(
    outputLimit,
    parsed.data.max_tokens || outputLimit,
    parsed.data.max_completion_tokens || outputLimit
  );
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const lastUserText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content
            .filter((part): part is JsonRecord => part !== null && typeof part === "object")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
  const recordId = stableHash("qoder-cn-record", modelKey, messages, tools, maxTokens);
  const sessionId = stableHash("qoder-cn-session", userId, modelKey);
  const tier = contextTier(modelConfig, system, messages, tools);
  const effectiveConfig = tier ? { ...modelConfig, max_input_tokens: tier } : { ...modelConfig };
  const payload: JsonRecord = {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system,
    messages,
    tools,
    parameters: { max_tokens: maxTokens, ...(tier ? { context_length: tier } : {}) },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: modelConfig.is_reasoning === true },
        originalContent: lastUserText,
        ...(tier ? { ideModelConfigOverride: { max_input_tokens: tier } } : {}),
      },
      features: [],
      text: lastUserText,
    },
    model_config: effectiveConfig,
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: randomUUID(),
      name: lastUserText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  if (plaintext.byteLength > 6 * 1024 * 1024) {
    throw new Error("Qoder CN chat request exceeds the size limit");
  }
  return { payload, plaintext };
}
