import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

/**
 * Portkey gateway — OpenAI-compatible. The Portkey API key is sent both as the Bearer
 * token and as `x-portkey-api-key`; an optional `providerSpecificData.virtualKey` adds
 * `x-portkey-virtual-key` (not needed when models are named `@provider/model`).
 * No models URL: Portkey catalogs are per-workspace, so models are user-named.
 */
export const portkeyProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "portkey",
  alias: "portkey",
  baseUrl: "https://api.portkey.ai/v1/chat/completions",
  models: [],
  passthroughModels: true,
});
