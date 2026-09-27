import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getRawProviderConnections } from "@/lib/db/providers";
import { loadLegacyKeyCatalog } from "./legacyCatalogLoader";
import type { LegacyProviderStore } from "./legacyProviderTool";

export const legacyProviderStore: LegacyProviderStore = {
  keyScope: async (token) => {
    const metadata = await getApiKeyMetadata(token);
    return metadata
      ? {
          allowedConnections: metadata.allowedConnections,
          allowedQuotas: metadata.allowedQuotas,
        }
      : null;
  },
  connections: async () => {
    const rows = await getRawProviderConnections({}, undefined, undefined, [
      "id",
      "provider",
      "is_active",
      "rate_limited_until",
      "test_status",
    ]);
    return rows
      .filter((row) => typeof row.id === "string" && typeof row.provider === "string")
      .map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        isActive: row.isActive !== false && row.isActive !== 0,
        rateLimitedUntil: typeof row.rateLimitedUntil === "string" ? row.rateLimitedUntil : null,
        testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
      }));
  },
  modelOwners: async (context) =>
    (await loadLegacyKeyCatalog(context)).map((model) => ({
      id: model.id,
      ownedBy: model.owned_by ?? "",
    })),
};
