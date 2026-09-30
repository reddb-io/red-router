import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

/** Helicone AI Gateway — unified OpenAI-compatible endpoint keyed by a Helicone API key. */
export const heliconeProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "helicone",
  alias: "helicone",
  baseUrl: "https://ai-gateway.helicone.ai/v1/chat/completions",
  modelsUrl: "https://ai-gateway.helicone.ai/v1/models",
  models: [],
  passthroughModels: true,
});
