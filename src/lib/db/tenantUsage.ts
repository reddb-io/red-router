import { getDbInstance } from "./core";
import { getTenant, TenantError } from "./tenants";

export function tenantMonthWindow(month: string) {
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    Number(month.slice(0, 4)) < 2000 ||
    Number(month.slice(0, 4)) > 9998
  ) {
    throw new TenantError("invalid", "Use a month in YYYY-MM format.");
  }
  const [year, index] = month.split("-").map(Number);
  return {
    since: new Date(Date.UTC(year, index - 1, 1)).toISOString(),
    until: new Date(Date.UTC(year, index, 1)).toISOString(),
  };
}

type Aggregate = {
  apiKeyId: string | null;
  name?: string;
  requests?: number;
  errors?: number;
  inputTokens?: number;
  outputTokens?: number;
  recordedCostUsd?: number;
  pricedRequests?: number;
};

/** Requests and recorded costs are separate sources, never joined row-to-row or double-counted. */
export function getTenantMonthlyUsage(tenantId: string, month: string) {
  if (!getTenant(tenantId)) throw new TenantError("not_found", "Tenant not found.");
  const { since, until } = tenantMonthWindow(month);
  const db = getDbInstance();
  const usage = db
    .prepare(
      `SELECT api_key_id AS apiKeyId, MAX(api_key_name) AS name,
    COUNT(*) AS requests, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
    COALESCE(SUM(tokens_input), 0) AS inputTokens, COALESCE(SUM(tokens_output), 0) AS outputTokens
    FROM usage_history WHERE tenant_id = ? AND timestamp >= ? AND timestamp < ? GROUP BY api_key_id`
    )
    .all(tenantId, since, until) as Aggregate[];
  const cost = db
    .prepare(
      `SELECT api_key_id AS apiKeyId, SUM(amount_usd) AS recordedCostUsd,
    COUNT(*) AS pricedRequests FROM request_cost_ledger
    WHERE tenant_id = ? AND timestamp >= ? AND timestamp < ? GROUP BY api_key_id`
    )
    .all(tenantId, since, until) as Aggregate[];
  const currentKeys = db
    .prepare("SELECT id AS apiKeyId, name FROM api_keys WHERE tenant_id = ?")
    .all(tenantId) as Aggregate[];
  const keys = new Map<
    string,
    Required<Omit<Aggregate, "apiKeyId">> & { apiKeyId: string | null; current: boolean }
  >();
  for (const entry of [...currentKeys, ...usage, ...cost]) {
    const id = entry.apiKeyId ?? "unkeyed";
    const existing = keys.get(id) ?? {
      apiKeyId: entry.apiKeyId,
      name: entry.apiKeyId ? "Deleted or moved key" : "Requests without a key",
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      recordedCostUsd: 0,
      pricedRequests: 0,
      current: currentKeys.some((key) => key.apiKeyId === entry.apiKeyId),
    };
    keys.set(id, {
      ...existing,
      ...entry,
      name: existing.current
        ? (currentKeys.find((key) => key.apiKeyId === entry.apiKeyId)?.name ?? existing.name)
        : entry.name || existing.name,
    });
  }
  const rows = [...keys.values()].sort(
    (a, b) => b.requests - a.requests || a.name.localeCompare(b.name)
  );
  const total = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      errors: sum.errors + row.errors,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      recordedCostUsd: sum.recordedCostUsd + row.recordedCostUsd,
      pricedRequests: sum.pricedRequests + row.pricedRequests,
    }),
    {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      recordedCostUsd: 0,
      pricedRequests: 0,
    }
  );
  return {
    month,
    timezone: "UTC",
    since,
    until,
    total,
    keys: rows,
    coverage:
      "Retained request history and recorded cost ledger. Historical tenant attribution is inferred from surviving keys at migration; older aggregates without key identity are excluded.",
  };
}
