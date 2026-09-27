import { resolveSearchProvider } from "@omniroute/open-sse/config/searchRegistry.ts";

export type SearchModelResolution = { ok: true; provider?: string } | { ok: false; reason: string };

/** Resolve 9router's model field without silently choosing a different provider. */
export function resolveNineRouterSearchModel(
  model: string | undefined,
  provider: string | undefined
): SearchModelResolution {
  if (!model) return { ok: true, provider };
  if (model === "search-combo") {
    return { ok: false, reason: "Configured search-combo routing is not available" };
  }
  const id = model.endsWith("/search") ? model.slice(0, -"/search".length) : model;
  const modelProvider = resolveSearchProvider(id);
  const requestedProvider = provider ? resolveSearchProvider(provider) : undefined;
  if (!modelProvider || (provider && requestedProvider?.id !== modelProvider.id)) {
    return { ok: false, reason: "Unknown or conflicting search model" };
  }
  return { ok: true, provider: modelProvider.id };
}
