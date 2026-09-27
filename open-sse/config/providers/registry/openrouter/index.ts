import type { RegistryEntry } from "../../shared.ts";

export const openrouterProvider: RegistryEntry = {
  id: "openrouter",
  alias: "openrouter",
  format: "openai",
  executor: "default",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  // #11226: OpenRouter's /api/v1/models is PUBLIC (200 with any or no key), so the
  // generic /models probe validated every key — even garbage ones — and bad keys
  // only surfaced later as upstream 401 "User not found." on real chat traffic.
  // /api/v1/auth/key is the authenticated key-info endpoint: 200 = valid, 401 = invalid.
  testKeyModelsUrl: "https://openrouter.ai/api/v1/auth/key",
  systemOneConfig: {
    baseUrl: "https://openrouter.ai/api/v1/systemone",
    models: [{ id: "typesafe/jev-1.13", name: "JEV 1.13" }],
    defaultModel: "typesafe/jev-1.13",
    modelMap: {
      "jev-1.13": "typesafe/jev-1.13",
      "jev-1.13.0": "typesafe/jev-1.13",
      "jev-latest": "typesafe/jev-1.13",
    },
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  headers: {
    "HTTP-Referer": "https://endpoint-proxy.local",
    "X-Title": "Endpoint Proxy",
  },
  // OpenRouter multiplexes hundreds of independent upstream models behind one
  // connection/API key — without this flag, hasPerModelQuota() (accountFallback.ts)
  // falls through to connection-wide cooldown on any model-specific failure (e.g. a
  // 404 "No endpoints found" for one dead/renamed model), poisoning every OTHER
  // OpenRouter model on the same connection for the cooldown window and surfacing
  // that first model's stale error message on their unrelated requests.
  passthroughModels: true,
  models: [{ id: "auto", name: "Auto (Best Available)" }],
};
