// LLM-gateway upstreams (Cloudflare AI Gateway, Helicone AI Gateway, Portkey).
// Pure helpers shared by the executor and the connection validator: chat-URL
// building for the per-account Cloudflare endpoint and the optional extra
// headers each gateway accepts, derived from the connection's providerSpecificData.
import { normalizeBaseUrl } from "../utils/urlSanitize.ts";

export const CLOUDFLARE_AI_GATEWAY_ID = "cloudflare-ai-gateway";
export const HELICONE_ID = "helicone";
export const PORTKEY_ID = "portkey";

export const CLOUDFLARE_AI_GATEWAY_ROOT_URL = "https://gateway.ai.cloudflare.com/v1";
export const HELICONE_BASE_URL = "https://ai-gateway.helicone.ai/v1";
export const PORTKEY_BASE_URL = "https://api.portkey.ai/v1";

export interface GatewayHeaderField {
  /** providerSpecificData keys checked in order; the first non-empty string wins. */
  psdKeys: readonly string[];
  header: string;
  /** Prepended to the value (for example "Bearer "). */
  prefix?: string;
}

/**
 * Optional per-connection headers. Values come from providerSpecificData, never
 * from source, so no credential is embedded here.
 */
export const GATEWAY_HEADER_FIELDS: Readonly<Record<string, readonly GatewayHeaderField[]>> = {
  // Authenticated gateways require `cf-aig-authorization: Bearer <gateway token>`.
  [CLOUDFLARE_AI_GATEWAY_ID]: [
    { psdKeys: ["cfAigToken", "gatewayToken"], header: "cf-aig-authorization", prefix: "Bearer " },
  ],
  // `@provider/model` slugs need no virtual key; otherwise Portkey routes by it.
  [PORTKEY_ID]: [{ psdKeys: ["virtualKey", "portkeyVirtualKey"], header: "x-portkey-virtual-key" }],
};

const HEADER_UNSAFE = /[\r\n\0]/;

function readPsdString(psd: Record<string, unknown> | null | undefined, keys: readonly string[]) {
  for (const key of keys) {
    const value = psd?.[key];
    if (typeof value === "string" && value.trim() && !HEADER_UNSAFE.test(value)) {
      return value.trim();
    }
  }
  return "";
}

/**
 * Extra request headers for a gateway connection. Portkey additionally needs its
 * own API key in `x-portkey-api-key` (the same key is sent as the Bearer token).
 * Returns an empty object for providers that are not one of the gateways.
 */
export function buildGatewayExtraHeaders(
  provider: string | null | undefined,
  apiKey: string | null | undefined,
  providerSpecificData?: Record<string, unknown> | null
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!provider) return headers;

  if (
    provider === PORTKEY_ID &&
    typeof apiKey === "string" &&
    apiKey &&
    !HEADER_UNSAFE.test(apiKey)
  ) {
    headers["x-portkey-api-key"] = apiKey;
  }

  for (const field of GATEWAY_HEADER_FIELDS[provider] ?? []) {
    const value = readPsdString(providerSpecificData, field.psdKeys);
    if (value) headers[field.header] = `${field.prefix ?? ""}${value}`;
  }
  return headers;
}

/**
 * Cloudflare AI Gateway chat URL from the per-account base URL the operator pastes.
 *  - `.../chat/completions`            -> used as given
 *  - `.../v1/{account}/{gateway}`      -> unified endpoint: `/compat/chat/completions`
 *  - `.../{account}/{gateway}/openai`  -> `/chat/completions` (also `/compat`, `/groq`, ...)
 * Unlike generic OpenAI-compatible hosts, no `/v1` segment is inserted: the
 * provider segment already carries the upstream API version.
 */
export function buildCloudflareAiGatewayChatUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  const queryIndex = normalized.search(/[?#]/);
  const endpoint = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  if (endpoint.endsWith("/chat/completions")) return normalized;
  const suffix = queryIndex === -1 ? "" : normalized.slice(queryIndex);

  let segments: string[] = [];
  try {
    segments = new URL(endpoint).pathname.split("/").filter(Boolean);
  } catch {
    segments = [];
  }
  // /v1/{account_id}/{gateway_id} has no provider segment yet.
  if (segments.length === 3 && segments[0] === "v1") {
    return `${endpoint}/compat/chat/completions${suffix}`;
  }
  return `${endpoint}/chat/completions${suffix}`;
}
