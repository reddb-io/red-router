import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

/**
 * Cloudflare AI Gateway (https://developers.cloudflare.com/ai-gateway/). The endpoint is
 * per-account (`/v1/{account_id}/{gateway_id}/...`), so the operator supplies it as the
 * connection Base URL (providerSpecificData.baseUrl); DefaultExecutor builds the chat URL
 * from it. `baseUrl` here is only the documented root, never dispatched to as-is.
 * Models are user-named (`openai/gpt-4o-mini` on /compat, `gpt-4o-mini` on /openai).
 * Optional `providerSpecificData.cfAigToken` becomes `cf-aig-authorization` for
 * authenticated gateways.
 */
export const cloudflare_ai_gatewayProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "cloudflare-ai-gateway",
  alias: "cfaig",
  baseUrl: "https://gateway.ai.cloudflare.com/v1",
  models: [],
  passthroughModels: true,
});
