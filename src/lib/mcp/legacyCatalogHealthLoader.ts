import { getRawProviderConnections } from "@/lib/db/providers";
import { isQuotaExhaustedForRequest } from "@/domain/quotaCache";
import { getModelLockoutInfo } from "@omniroute/open-sse/services/accountFallback";

import type { LegacyCatalogHealthLoader } from "./legacyCatalogTools";
import { buildLegacyCatalogHealth, type LegacyHealthConnection } from "./legacyCatalogHealth";
import { LegacyMcpToolError } from "./legacyProtocol";
import { legacyProviderStore } from "./legacyProviderStore";

/** Read projected metadata only: no credential fields are decrypted or returned. */
export const loadLegacyCatalogHealth: LegacyCatalogHealthLoader = async (context, models) => {
  if (!context.apiKeyToken) throw new LegacyMcpToolError("forbidden", "API key required");
  const scope = await legacyProviderStore.keyScope(context.apiKeyToken);
  if (!scope) throw new LegacyMcpToolError("forbidden", "API key not found");
  const allowedIds = scope.allowedQuotas.length
    ? new Set(
        scope.quotaConnections.filter(
          (id) => scope.allowedConnections.length === 0 || scope.allowedConnections.includes(id)
        )
      )
    : scope.allowedConnections.length
      ? new Set(scope.allowedConnections)
      : null;
  const rows = await getRawProviderConnections({}, undefined, undefined, [
    "id",
    "provider",
    "is_active",
    "rate_limited_until",
    "test_status",
  ]);
  const connections: LegacyHealthConnection[] = rows
    .filter((row) => typeof row.id === "string" && typeof row.provider === "string")
    .map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      isActive: row.isActive !== false && row.isActive !== 0,
      rateLimitedUntil: typeof row.rateLimitedUntil === "string" ? row.rateLimitedUntil : null,
      testStatus: typeof row.testStatus === "string" ? row.testStatus : null,
    }));
  return buildLegacyCatalogHealth(models, connections, allowedIds, {
    modelLock: getModelLockoutInfo,
    quotaExhausted: isQuotaExhaustedForRequest,
  });
};
