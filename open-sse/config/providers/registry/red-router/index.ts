import type { RegistryEntry } from "../../shared.ts";

/**
 * RedRouter — self-upstream chat and decision entry (another RedRouter instance).
 *
 * Ported from the legacy fork (open-sse/providers/registry/red-router.js @
 * c66f917c). Connect to another RedRouter with its URL + a RedRouter API key;
 * accounts and provider access stay on the remote machine. The default baseUrl
 * targets a same-host RedRouter (127.0.0.1:25050); per connection, the
 * operator overrides it via providerSpecificData.baseUrl, which the
 * openai-format DefaultExecutor branch already honors.
 *
 * Chat and native decision discovery is persisted per credential by
 * src/lib/providerModels/remoteRouterDiscovery.ts. Each local hop adds `red/`
 * to the remote model ID; legacy `red-router/` routes remain accepted.
 */
export const red_routerProvider: RegistryEntry = {
  id: "red-router",
  alias: "red",
  format: "openai",
  executor: "default",
  baseUrl: "http://127.0.0.1:25050/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};

export default red_routerProvider;
