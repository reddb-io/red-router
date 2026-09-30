// Key validation for the Cloudflare AI Gateway upstream. The endpoint is per account and has
// no models listing, so the probe is a one-token chat call against the operator's gateway URL.
// Helicone and Portkey use the generic OpenAI-like probe (see validation.ts).
import {
  CLOUDFLARE_AI_GATEWAY_ID,
  buildCloudflareAiGatewayChatUrl,
  buildGatewayExtraHeaders,
} from "@omniroute/open-sse/config/gatewayProviders.ts";
import { normalizeBaseUrl } from "./urlHelpers";
import { buildBearerHeaders } from "./headers";
import { validateDirectChatProvider } from "./directChatProbe";

export async function validateCloudflareAiGatewayProvider({
  apiKey,
  providerSpecificData = {},
}: any) {
  const baseUrl = normalizeBaseUrl(providerSpecificData?.baseUrl);
  if (!baseUrl) {
    return {
      valid: false,
      error:
        "Cloudflare AI Gateway requires a Base URL " +
        "(https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat).",
    };
  }

  // /compat takes provider-prefixed ids; provider paths (/openai, ...) take plain ids.
  const url = buildCloudflareAiGatewayChatUrl(baseUrl);
  const defaultModel = url.includes("/compat/") ? "openai/gpt-4o-mini" : "gpt-4o-mini";

  return validateDirectChatProvider({
    url,
    headers: {
      ...buildBearerHeaders(apiKey, providerSpecificData),
      ...buildGatewayExtraHeaders(CLOUDFLARE_AI_GATEWAY_ID, apiKey, providerSpecificData),
    },
    body: {
      model: providerSpecificData?.validationModelId || defaultModel,
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1,
    },
    providerSpecificData,
  });
}
