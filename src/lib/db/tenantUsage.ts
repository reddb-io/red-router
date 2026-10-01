import { getMonthlyCostReport, monthlyUsageWindow } from "./monthlyCostReport";

export const tenantMonthWindow = monthlyUsageWindow;

/** Preserve the existing tenant API fields while using the common monthly snapshot.
 * `pricedRequests` is a legacy field name: it counts ledger entries, not priced requests.
 */
export function getTenantMonthlyUsage(tenantId: string, month: string) {
  const reconciliation = getMonthlyCostReport(month, { tenantId });
  const legacy = (row: typeof reconciliation.total) => ({
    requests: row.requests,
    errors: row.errors,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    recordedCostUsd: row.recordedCostUsd ?? 0,
    pricedRequests: row.ledgerEntries,
  });
  return {
    month,
    timezone: reconciliation.timezone,
    since: reconciliation.since,
    until: reconciliation.until,
    total: legacy(reconciliation.total),
    keys: reconciliation.keys.map((row) => ({
      ...legacy(row),
      apiKeyId: row.apiKeyId,
      name: row.name,
      current: row.current,
    })),
    coverage: reconciliation.coverage,
    reconciliation,
  };
}
