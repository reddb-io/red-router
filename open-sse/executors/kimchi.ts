import { DefaultExecutor } from "./default.ts";
import type { ProviderCredentials } from "./base.ts";

const TOP_LEVEL_OPENAI_GATEWAY_DROPS = [
  "anthropic_version",
  "anthropic_beta",
  "client_metadata",
  "mcp_servers",
  "stop_sequences",
  "thinking",
  "top_k",
] as const;

type JsonRecord = Record<string, unknown>;

function systemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as JsonRecord).text === "string") {
          return (part as JsonRecord).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function mergeTopLevelSystem(body: JsonRecord): void {
  if (!body.system || !Array.isArray(body.messages)) return;
  const text = systemToText(body.system).trim();
  if (!text) return;

  const messages = body.messages as Array<JsonRecord | unknown>;
  const existing = messages.find(
    (msg) => msg && typeof msg === "object" && (msg as JsonRecord).role === "system"
  ) as JsonRecord | undefined;
  if (!existing) {
    messages.unshift({ role: "system", content: text });
    return;
  }

  if (typeof existing.content === "string") {
    existing.content = `${text}\n\n${existing.content}`;
  } else if (Array.isArray(existing.content)) {
    (existing.content as unknown[]).unshift({ type: "text", text });
  }
}

function stripMessageArtifacts(body: JsonRecord): void {
  if (!Array.isArray(body.messages)) return;
  for (const rawMsg of body.messages) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    const msg = rawMsg as JsonRecord;
    delete msg.cache_control;
    if (!Array.isArray(msg.content)) continue;
    msg.content = (msg.content as unknown[]).map((part) => {
      if (!part || typeof part !== "object") return part;
      const { cache_control, signature, ...clean } = part as JsonRecord;
      void cache_control;
      void signature;
      return clean;
    });
  }
}

function stripToolArtifacts(body: JsonRecord): void {
  if (!Array.isArray(body.tools)) return;
  body.tools = (body.tools as unknown[]).map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const { cache_control, ...clean } = tool as JsonRecord;
    void cache_control;
    return clean;
  });
}

// Strip `reasoning_content` echoed by clients on assistant messages — but
// only when it's a real thinking block. `DefaultExecutor.transformRequest`
// runs `injectReasoningContent` first and may inject a 1-char placeholder
// (" ") for upstream validation; the placeholder is small (no token cost
// worth stripping) and stripping it would re-trigger upstream to complain
// about missing reasoning on the next turn. Threshold matches the
// placeholder length with a safety margin.
const REASONING_PLACEHOLDER_MAX_LEN = 8;

export function stripReasoningContent(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const typed = body as JsonRecord;
  if (!Array.isArray(typed.messages)) return;
  for (const rawMsg of typed.messages) {
    if (!rawMsg || typeof rawMsg !== "object") continue;
    const msg = rawMsg as JsonRecord;
    if (
      msg.role === "assistant" &&
      typeof msg.reasoning_content === "string" &&
      (msg.reasoning_content as string).length > REASONING_PLACEHOLDER_MAX_LEN
    ) {
      delete msg.reasoning_content;
    }
  }
}

// TODO(fork-port): the legacy fork also consulted the Kimchi live catalog
// metadata (open-sse/services/kimchiModels.js @ c66f917c) to detect
// Anthropic-backed models whose IDs don't spell "claude". This base has no
// kimchiModels service yet, so detection falls back to the model-id regex —
// which covers every Claude/Kimchi entry advertised today.
function isAnthropicBackedKimchiModel(model: string): boolean {
  return /(^|[-_/])(?:claude|anthropic)(?:[-_/]|$)/i.test(String(model || ""));
}

/**
 * KimchiExecutor — llm.kimchi.dev OpenAI-compatible gateway.
 *
 * Ported from the legacy fork (open-sse/executors/kimchi.js @ c66f917c). Kimchi
 * fronts multiple upstream backends (OpenAI-shaped gateways plus Anthropic),
 * so the request needs pre-flight cleanup: merge the Anthropic-style top-level
 * `system` into a system message, drop top-level fields OpenAI gateways reject,
 * strip Anthropic cache/signature artifacts from messages and tools, and (for
 * Anthropic-backed models) drop OpenAI reasoning selectors the backend rejects.
 */
export class KimchiExecutor extends DefaultExecutor {
  constructor() {
    super("kimchi");
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) {
      return transformed;
    }

    const out = transformed as JsonRecord;

    mergeTopLevelSystem(out);
    for (const key of TOP_LEVEL_OPENAI_GATEWAY_DROPS) {
      if (out[key] !== undefined) delete out[key];
    }
    delete out.system;

    if (isAnthropicBackedKimchiModel(model)) {
      delete out.reasoning_effort;
      delete out.reasoning;
      delete out.thinking;
    }

    stripMessageArtifacts(out);
    stripToolArtifacts(out);
    stripReasoningContent(out);
    return out;
  }
}

export default KimchiExecutor;
