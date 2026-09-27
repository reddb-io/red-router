import {
  WEB_FETCH_PROVIDERS,
  type WebFetchProviderId,
  type WebFetchResponse,
} from "@omniroute/open-sse/handlers/webFetch.ts";

const LEGACY_PROVIDER_ALIASES: Record<string, WebFetchProviderId> = {
  exa: "exa-search",
  jina: "jina-reader",
  ollama: "ollama-cloud",
  tavily: "tavily-search",
};

const LEGACY_PROVIDER_NAMES: Partial<Record<WebFetchProviderId, string>> = {
  "exa-search": "exa",
  "ollama-cloud": "ollama",
  "tavily-search": "tavily",
};

export type WebFetchModelResolution =
  { ok: true; provider?: WebFetchProviderId; legacyResponse: boolean } | { ok: false };

/** A model field is the unambiguous marker for 9router's web-fetch contract. */
export function resolveWebFetchModel(
  provider: WebFetchProviderId | undefined,
  model: string | undefined,
  legacyHeader: string | null = null
): WebFetchModelResolution {
  if (!model) {
    return { ok: true, provider, legacyResponse: legacyHeader === "1" };
  }
  if (model === "fetch-combo") {
    return provider ? { ok: false } : { ok: true, legacyResponse: true };
  }
  const name = model.endsWith("/fetch") ? model.slice(0, -"/fetch".length) : model;
  const resolved = WEB_FETCH_PROVIDERS.includes(name as WebFetchProviderId)
    ? (name as WebFetchProviderId)
    : LEGACY_PROVIDER_ALIASES[name];
  if (!resolved || (provider && provider !== resolved)) return { ok: false };
  return { ok: true, provider: resolved, legacyResponse: true };
}

/** Adapt only negotiated requests; the existing provider-only response stays stable. */
export function toNineRouterWebFetchResponse(
  data: WebFetchResponse,
  format: string,
  responseTimeMs: number,
  upstreamLatencyMs: number
) {
  return {
    provider: LEGACY_PROVIDER_NAMES[data.provider as WebFetchProviderId] ?? data.provider,
    url: data.url,
    title: data.metadata?.title ?? null,
    content: { format, text: data.content, length: data.content.length },
    links: data.links,
    metadata: { author: null, published_at: null, language: null },
    usage: { fetch_cost_usd: null },
    metrics: { response_time_ms: responseTimeMs, upstream_latency_ms: upstreamLatencyMs },
  };
}
