import type { RegistryEntry } from "../../shared.ts";

/**
 * Xiaomi MiMo Code Free (api.xiaomimimo.com/api/free-ai).
 *
 * Ported from the legacy fork (open-sse/providers/registry/mimo-free.js @
 * c66f917c). No auth: the executor bootstraps an anonymous JWT per process
 * (device fingerprint as client id) — see open-sse/executors/mimo-free.ts.
 *
 * Hidden: Xiaomi ended the free MiMo channel ("MiMo free API service has
 * ended"). Kept functional for operators with an unofficially-alive endpoint;
 * hide from the dashboard until a replacement (OAuth MiMo Platform) is wired.
 *
 * TODO(fork-port): the legacy registry discovered its model list from
 * https://models.dev/api.json (modelsFetcher type "mimo-free"); this base has
 * no models.dev catalog source wired into the registry, so the static entry
 * below plus `passthroughModels` is the discovery path.
 */
export const mimo_freeProvider: RegistryEntry = {
  id: "mimo-free",
  alias: "mmf",
  format: "openai",
  executor: "mimo-free",
  baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
  authType: "none",
  authHeader: "none",
  passthroughModels: true,
  models: [{ id: "mimo-auto", name: "MiMo Auto" }],
};

export default mimo_freeProvider;
