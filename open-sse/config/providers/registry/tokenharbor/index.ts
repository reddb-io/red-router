import type { RegistryEntry } from "../../shared.ts";

/** Token Harbor forwards OpenAI-compatible requests to its live model catalog. */
export const tokenharborProvider: RegistryEntry = {
  id: "tokenharbor",
  alias: "tokenharbor",
  format: "openai",
  executor: "default",
  baseUrl: "https://tokenharbor.ai/v1/chat/completions",
  modelsUrl: "https://tokenharbor.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  // The seed is an offline fallback. Upstream model ids are unprefixed and rotate.
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "grok-4.7", name: "Grok 4.7" },
  ],
  passthroughModels: true,
};
