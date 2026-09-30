/**
 * db/costAttribution.ts — read-only spend rollup by request tag or end user, over the cost
 * ledger's attribution columns (migration 206).
 *
 * Only metered spend reaches the ledger (a call with no cost writes no row), so these totals are
 * the metered spend of the tagged / attributed traffic. `end_user` and `tags` are client-supplied
 * text: they are returned as data and must be escaped by whatever renders them.
 *
 * @module db/costAttribution
 */

import { getDbInstance } from "./core";

export const ATTRIBUTION_DIMENSIONS = ["tag", "user"] as const;
export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];

/** Rows returned by a rollup, largest spend first. */
export const ATTRIBUTION_ROLLUP_LIMIT = 100;

export interface AttributionRollupRow {
  /** The tag, or the end-user id. */
  key: string;
  amountUsd: number;
  requestCount: number;
}

export function getAttributionRollup(
  by: AttributionDimension,
  days: number,
  now = Date.now()
): AttributionRollupRow[] {
  const sinceIso = new Date(now - days * 86_400_000).toISOString();
  const sql =
    by === "user"
      ? `SELECT end_user AS key, COALESCE(SUM(amount_usd), 0) AS amount_usd, COUNT(*) AS request_count
           FROM request_cost_ledger
          WHERE end_user IS NOT NULL AND timestamp >= ?
          GROUP BY end_user
          ORDER BY amount_usd DESC, key ASC
          LIMIT ${ATTRIBUTION_ROLLUP_LIMIT}`
      : // A row with several tags counts toward each of them. json_valid guards a hand-edited row.
        `SELECT j.value AS key, COALESCE(SUM(l.amount_usd), 0) AS amount_usd, COUNT(*) AS request_count
           FROM request_cost_ledger l,
                json_each(CASE WHEN json_valid(l.tags) THEN l.tags ELSE '[]' END) j
          WHERE l.tags IS NOT NULL AND l.timestamp >= ? AND j.type = 'text'
          GROUP BY j.value
          ORDER BY amount_usd DESC, key ASC
          LIMIT ${ATTRIBUTION_ROLLUP_LIMIT}`;
  const rows = getDbInstance().prepare(sql).all(sinceIso) as Array<{
    key: unknown;
    amount_usd: unknown;
    request_count: unknown;
  }>;
  return rows.map((row) => ({
    key: String(row.key),
    amountUsd: Number(row.amount_usd),
    requestCount: Number(row.request_count),
  }));
}
