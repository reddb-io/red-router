import { parseLegacyQuotaWindows } from "./legacyQuotaTool";

interface QuotaRefreshResult {
  usage: { _stale?: unknown };
  cache: { quotas: unknown; fetchedAt: string; message: string | null };
}

async function fetchProviderQuota(connectionId: string): Promise<QuotaRefreshResult> {
  const { fetchAndPersistProviderLimits } = await import("@/lib/usage/providerLimits");
  return fetchAndPersistProviderLimits(connectionId, "manual", {
    allowRotatingRefresh: true,
  });
}

/** The live provider-limits dependency is kept out of the core MCP protocol typecheck graph. */
export async function refreshLegacyQuotaConnection(
  connectionId: string,
  fetcher: (id: string) => Promise<QuotaRefreshResult> = fetchProviderQuota
) {
  const { usage, cache } = await fetcher(connectionId);
  if (usage._stale === true || cache.message) {
    throw new Error("quota refresh returned stale data");
  }
  return parseLegacyQuotaWindows(cache.quotas, cache.fetchedAt);
}
