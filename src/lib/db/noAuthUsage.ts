import { getDbInstance } from "./core";

/**
 * Providers with at least one successful request recorded in `usage_history`
 * since `sinceIso`. One grouped query; returns the raw `provider` column values
 * (ids or aliases) and an empty list when the table/columns are unavailable.
 * Used to tell operators which free sources they were already using before the
 * opt-in change, so the UI can offer to enable them (never enables anything).
 */
export function listProvidersWithSuccessSince(sinceIso: string): string[] {
  try {
    const rows = getDbInstance()
      .prepare(
        "SELECT provider FROM usage_history WHERE success = 1 AND timestamp >= ? AND provider IS NOT NULL GROUP BY provider"
      )
      .all(sinceIso) as Array<{ provider?: unknown }>;
    return rows.map((row) => row.provider).filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}
