import {
  isUnconfiguredLoopbackSearchProvider,
  type SearchProviderConfig,
} from "@omniroute/open-sse/config/searchRegistry";
import { resolveSearchBaseUrl } from "@omniroute/open-sse/handlers/search/baseUrl";

export type VirtualWebModelKind = "webSearch" | "webFetch";

export type VirtualWebCatalogModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  root: "search" | "fetch";
  name: string;
  type: VirtualWebModelKind;
  params: string[];
  searchTypes?: string[];
  maxResults?: number;
};

const SEARCH_PARAMS = [
  "query",
  "max_results",
  "country",
  "language",
  "time_range",
  "domain_filter",
  "search_type",
];
const FETCH_PARAMS = ["url", "format", "max_characters"];

/** SearXNG's catalog localhost is not a configured service by itself. */
export function hasConfiguredSearchUrl(
  provider: SearchProviderConfig,
  connections: readonly { providerSpecificData?: unknown }[]
): boolean {
  if (!isUnconfiguredLoopbackSearchProvider(provider)) return true;
  return connections.some((connection) => {
    try {
      const data = connection.providerSpecificData;
      const baseUrl = resolveSearchBaseUrl(provider, {
        providerSpecificData:
          data && typeof data === "object" ? (data as Record<string, unknown>) : undefined,
      });
      return !isUnconfiguredLoopbackSearchProvider({ ...provider, baseUrl });
    } catch {
      return false;
    }
  });
}

/** Virtual endpoint entries are still filtered by the caller's catalog key policy. */
export function buildVirtualWebCatalogModels(input: {
  timestamp: number;
  searchProviders: readonly SearchProviderConfig[];
  fetchProviderIds: readonly string[];
  isEligible: (
    providerId: string,
    modelId: "search" | "fetch",
    kind: VirtualWebModelKind
  ) => boolean;
}): VirtualWebCatalogModel[] {
  const models: VirtualWebCatalogModel[] = [];
  for (const provider of input.searchProviders) {
    if (provider.disabled || !input.isEligible(provider.id, "search", "webSearch")) continue;
    models.push({
      id: `${provider.id}/search`,
      object: "model",
      created: input.timestamp,
      owned_by: provider.id,
      root: "search",
      name: `${provider.name} Search`,
      type: "webSearch",
      params: SEARCH_PARAMS,
      searchTypes: provider.searchTypes,
      maxResults: provider.maxMaxResults,
    });
  }
  for (const providerId of input.fetchProviderIds) {
    if (!input.isEligible(providerId, "fetch", "webFetch")) continue;
    models.push({
      id: `${providerId}/fetch`,
      object: "model",
      created: input.timestamp,
      owned_by: providerId,
      root: "fetch",
      name: `${providerId} Fetch`,
      type: "webFetch",
      params: FETCH_PARAMS,
    });
  }
  return models;
}
