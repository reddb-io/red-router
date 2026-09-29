/**
 * Scrape-time aggregates for the Prometheus endpoint (GET /api/metrics).
 *
 * All SQL for the endpoint lives here (routes never issue SQL). Everything is computed at scrape
 * time from rows the router already records — there is no hot-path instrumentation:
 *
 * - `usage_history`      one row per completed request: provider, model, status, success,
 *                        latency and token counts. Source of requests, tokens and latency.
 * - `request_cost_ledger` one row per priced request. Source of cost.
 *
 * Aggregates run over ALL retained history (not a sliding window) so counters stay monotonic
 * between scrapes; the only way a counter can fall is the operator's retention cleanup deleting
 * old rows, which Prometheus treats as an ordinary counter reset. Each aggregate is one grouped
 * scan; the collector caches the result for a few seconds so a fast scraper cannot hammer SQLite.
 *
 * A missing table (very old or partially migrated database) yields empty results, never a throw.
 */

import { getDbInstance } from "./core";
import { REQUEST_DURATION_BUCKETS_SECONDS as LATENCY_BUCKET_BOUNDS_SECONDS } from "@/lib/metrics/prometheusText";

export interface UsageAggregateRow {
  provider: string;
  model: string;
  /** "2xx" | "3xx" | "4xx" | "5xx" | "1xx" | "error" (no numeric status, success=0) */
  statusClass: string;
  requests: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  latencyMsSum: number;
  /** Cumulative counts: rows with latency <= LATENCY_BUCKET_BOUNDS_SECONDS[i]. */
  latencyBuckets: number[];
}

export interface CostAggregateRow {
  provider: string;
  model: string;
  costUsd: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tableExists(name: string): boolean {
  try {
    const row = getDbInstance()
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Requests, tokens and latency per provider + model + status class over all history. */
export function queryUsageAggregates(): UsageAggregateRow[] {
  if (!tableExists("usage_history")) return [];
  const bucketSelects = LATENCY_BUCKET_BOUNDS_SECONDS.map(
    (bound, index) =>
      `SUM(CASE WHEN COALESCE(latency_ms, 0) <= ${Math.round(bound * 1000)} THEN 1 ELSE 0 END) AS b${index}`
  ).join(",\n      ");
  const sql = `
    SELECT
      COALESCE(NULLIF(TRIM(provider), ''), 'unknown') AS provider,
      COALESCE(NULLIF(TRIM(model), ''), 'unknown') AS model,
      CASE
        -- status is stored as text and, for numeric writes, often as '429.0'; CAST reads both.
        WHEN CAST(status AS INTEGER) BETWEEN 100 AND 599 THEN (CAST(status AS INTEGER) / 100) || 'xx'
        WHEN success = 1 THEN '2xx'
        ELSE 'error'
      END AS status_class,
      COUNT(*) AS requests,
      SUM(COALESCE(tokens_input, 0)) AS tokens_input,
      SUM(COALESCE(tokens_output, 0)) AS tokens_output,
      SUM(COALESCE(tokens_cache_read, 0)) AS tokens_cache_read,
      SUM(COALESCE(tokens_cache_creation, 0)) AS tokens_cache_write,
      SUM(COALESCE(latency_ms, 0)) AS latency_ms_sum,
      ${bucketSelects}
    FROM usage_history
    GROUP BY 1, 2, 3
  `;
  try {
    const rows = getDbInstance().prepare(sql).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      statusClass: String(row.status_class),
      requests: num(row.requests),
      tokensInput: num(row.tokens_input),
      tokensOutput: num(row.tokens_output),
      tokensCacheRead: num(row.tokens_cache_read),
      tokensCacheWrite: num(row.tokens_cache_write),
      latencyMsSum: num(row.latency_ms_sum),
      latencyBuckets: LATENCY_BUCKET_BOUNDS_SECONDS.map((_, index) => num(row[`b${index}`])),
    }));
  } catch {
    return [];
  }
}

/** Priced cost per provider + model over the whole cost ledger. */
export function queryCostAggregates(): CostAggregateRow[] {
  if (!tableExists("request_cost_ledger")) return [];
  try {
    const rows = getDbInstance()
      .prepare(
        `SELECT
           COALESCE(NULLIF(TRIM(provider), ''), 'unknown') AS provider,
           COALESCE(NULLIF(TRIM(model), ''), 'unknown') AS model,
           SUM(COALESCE(amount_usd, 0)) AS cost_usd
         FROM request_cost_ledger
         GROUP BY 1, 2`
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      costUsd: num(row.cost_usd),
    }));
  } catch {
    return [];
  }
}
