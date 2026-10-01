import { getDbInstance } from "./core";
import { getTenant, TenantError } from "./tenants";
import { isReportingMonth } from "@/lib/usage/reportingMonth";

export function monthlyUsageWindow(month: string) {
  if (!isReportingMonth(month)) {
    throw new TenantError("invalid", "Use a month in YYYY-MM format.");
  }
  const [year, index] = month.split("-").map(Number);
  return {
    since: new Date(Date.UTC(year, index - 1, 1)).toISOString(),
    until: new Date(Date.UTC(year, index, 1)).toISOString(),
  };
}

export interface MonthlyUsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  ledgerEntries: number;
  recordedCostUsd: number | null;
}

export interface MonthlyUsageKey extends MonthlyUsageTotals {
  tenantId: string | null;
  tenantName: string;
  apiKeyId: string | null;
  name: string;
  current: boolean;
  lastUsed: string | null;
}

export interface MonthlyCostReport {
  month: string;
  timezone: "UTC";
  since: string;
  until: string;
  total: MonthlyUsageTotals;
  keys: MonthlyUsageKey[];
  sources: { requests: "usage_history"; cost: "request_cost_ledger" };
  coverage: string;
}

export const MONTHLY_USAGE_COVERAGE =
  "Retained request history and recorded cost entries, including failed calls. No recorded entries means unknown cost, not free usage. Entry counts are not pricing coverage: one request can have several charges, and history has no shared request identity. Older summaries without tenant/key identity are excluded. Recorded amounts may be estimates or budget charges; they are not provider invoices. Historical tenant attribution was inferred from surviving keys at migration and is preserved after key moves or deletion.";

type Scope = { tenantId?: string; apiKeyIds?: readonly string[] };
type AggregateRow = {
  tenantId: string | null;
  apiKeyId: string | null;
  name: string | null;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  lastUsed: string | null;
  ledgerEntries: number;
  amount: number;
};

/** One snapshot and one window for Keys, Cost Overview and tenant reports.
 * Aggregate each source separately: joining individual rows would multiply charges.
 * Ownership is read from each event, never inferred again from the key's current tenant.
 */
export function getMonthlyCostReport(month: string, scope: Scope = {}): MonthlyCostReport {
  const { since, until } = monthlyUsageWindow(month);
  if (scope.tenantId && !getTenant(scope.tenantId)) {
    throw new TenantError("not_found", "Tenant not found.");
  }
  const db = getDbInstance();
  return db.transaction((): MonthlyCostReport => {
    const params: (string | number)[] = [since, until];
    const conditions = ["timestamp >= ?", "timestamp < ?"];
    if (scope.tenantId) {
      conditions.push("tenant_id = ?");
      params.push(scope.tenantId);
    }
    if (scope.apiKeyIds?.length) {
      conditions.push(`api_key_id IN (${scope.apiKeyIds.map(() => "?").join(", ")})`);
      params.push(...scope.apiKeyIds);
    }
    const where = conditions.join(" AND ");
    const usage = db
      .prepare(
        `SELECT tenant_id AS tenantId,
      NULLIF(api_key_id, '') AS apiKeyId, MAX(api_key_name) AS name,
      COUNT(*) AS requests, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(tokens_input), 0) AS inputTokens,
      COALESCE(SUM(tokens_output), 0) AS outputTokens, MAX(timestamp) AS lastUsed
      FROM usage_history WHERE ${where}
      GROUP BY tenant_id, NULLIF(api_key_id, '')`
      )
      .all(...params) as AggregateRow[];
    const costs = db
      .prepare(
        `SELECT tenant_id AS tenantId,
      NULLIF(api_key_id, '') AS apiKeyId, COUNT(*) AS ledgerEntries,
      COALESCE(SUM(amount_usd), 0) AS amount
      FROM request_cost_ledger WHERE ${where}
      GROUP BY tenant_id, NULLIF(api_key_id, '')`
      )
      .all(...params) as AggregateRow[];
    const currentKeys = db
      .prepare("SELECT id, name, tenant_id AS tenantId FROM api_keys")
      .all() as { id: string; name: string; tenantId: string }[];
    const keyById = new Map(currentKeys.map((key) => [key.id, key]));
    const names = new Map(
      (db.prepare("SELECT id, name FROM tenants").all() as { id: string; name: string }[]).map(
        (tenant) => [tenant.id, tenant.name]
      )
    );
    const rows = new Map<string, MonthlyUsageKey>();
    const add = (tenantId: string | null, apiKeyId: string | null) => {
      const id = JSON.stringify([tenantId, apiKeyId]);
      let row = rows.get(id);
      if (!row) {
        const key = apiKeyId ? keyById.get(apiKeyId) : undefined;
        row = {
          tenantId,
          tenantName: tenantId ? (names.get(tenantId) ?? "Deleted tenant") : "Unattributed tenant",
          apiKeyId,
          name: key?.name ?? (apiKeyId ? "Deleted key" : "Requests without a key"),
          current: !!key && key.tenantId === tenantId,
          requests: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          ledgerEntries: 0,
          recordedCostUsd: null,
          lastUsed: null,
        };
        rows.set(id, row);
      }
      return row;
    };
    for (const key of currentKeys) {
      if (scope.tenantId && key.tenantId !== scope.tenantId) continue;
      if (scope.apiKeyIds?.length && !scope.apiKeyIds.includes(key.id)) continue;
      add(key.tenantId, key.id);
    }
    for (const entry of usage) {
      const row = add(entry.tenantId, entry.apiKeyId);
      if (!row.current && entry.name) row.name = entry.name;
      row.requests = entry.requests;
      row.errors = entry.errors;
      row.inputTokens = entry.inputTokens;
      row.outputTokens = entry.outputTokens;
      row.lastUsed = entry.lastUsed;
    }
    for (const entry of costs) {
      const row = add(entry.tenantId, entry.apiKeyId);
      row.ledgerEntries = entry.ledgerEntries;
      row.recordedCostUsd = entry.amount;
    }
    const keys = [...rows.values()].sort(
      (a, b) =>
        b.requests - a.requests ||
        a.tenantName.localeCompare(b.tenantName) ||
        a.name.localeCompare(b.name)
    );
    const total: MonthlyUsageTotals = {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      ledgerEntries: 0,
      recordedCostUsd: null,
    };
    for (const row of keys) {
      total.requests += row.requests;
      total.errors += row.errors;
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.ledgerEntries += row.ledgerEntries;
      if (row.recordedCostUsd !== null) {
        total.recordedCostUsd = (total.recordedCostUsd ?? 0) + row.recordedCostUsd;
      }
    }
    return {
      month,
      timezone: "UTC",
      since,
      until,
      keys,
      total,
      sources: { requests: "usage_history", cost: "request_cost_ledger" },
      coverage: MONTHLY_USAGE_COVERAGE,
    };
  })();
}
