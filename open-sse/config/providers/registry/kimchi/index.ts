import type { RegistryEntry } from "../../shared.ts";

/**
 * Kimchi (kimchi.dev) — multi-backend OpenAI-compatible gateway
 * (llm.kimchi.dev/openai/v1). Fronts Anthropic, MiniMax, Kimi and Nemotron
 * upstreams behind one key.
 *
 * Ported from the legacy fork (open-sse/providers/registry/kimchi.js @
 * c66f917c). Auth: bearer token; the upstream accepts the Kimchi web-app
 * OAuth token or a plain API key alike.
 *
 * TODO(fork-port): the legacy fork used a dedicated metadata catalog
 * (/v1/models/metadata?include_in_cli=true) that tagged Anthropic-backed
 * models; this base discovers via the standard OpenAI listing
 * (open-sse/services/kimchiModels.ts not ported), so Anthropic-backed IDs
 * that do not spell "claude" fall back to the executor's regex check.
 */
export const kimchiProvider: RegistryEntry = {
  id: "kimchi",
  alias: "kimchi",
  format: "openai",
  executor: "kimchi",
  baseUrl: "https://llm.kimchi.dev/openai/v1/chat/completions",
  modelsUrl: "https://llm.kimchi.dev/v1/models",
  authType: "oauth",
  authHeader: "bearer",
  headers: {
    "User-Agent": "kimchi/0.1.50",
  },
  passthroughModels: true,
  models: [
    { id: "minimax-m3", name: "MiniMax-M3", supportsVision: true },
    { id: "kimi-k2.7", name: "Kimi-K2.7" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    { id: "nemotron-3-ultra-fp4", name: "Nemotron 3 Ultra FP4" },
    { id: "minimax-m2.7", name: "MiniMax-M2.7" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  ],
};

export default kimchiProvider;
