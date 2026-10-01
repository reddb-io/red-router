import { getDbInstance } from "./core";

export interface ReservationScope {
  budgetId: string;
  scopeValue: string;
  windowStart: number;
  capKey: string;
}

/** Locks admission and its reservation together across SQLite connections. */
export function withBudgetAdmissionTransaction<T>(action: () => T): T {
  let result: T;
  getDbInstance().immediate(() => {
    result = action();
  });
  return result!;
}

export function getReservedKeyCost(keyId: string, since = 0, now = Date.now()): number {
  const row = getDbInstance()
    .prepare(
      "SELECT COALESCE(SUM(usd), 0) AS usd FROM budget_inflight WHERE api_key_id = ? AND created_at >= ? AND expires_at > ?"
    )
    .get(keyId, since, now) as { usd: number };
  return row.usd;
}

export function getReservedScopeCost(scope: ReservationScope, now = Date.now()): number {
  const row = getDbInstance()
    .prepare(
      `SELECT COALESCE(SUM(r.usd), 0) AS usd FROM budget_inflight r
    JOIN budget_inflight_scopes s ON s.reservation_id = r.id
    WHERE s.budget_id = ? AND s.scope_value = ? AND s.window_start = ? AND s.cap_key = ? AND r.expires_at > ?`
    )
    .get(scope.budgetId, scope.scopeValue, scope.windowStart, scope.capKey, now) as { usd: number };
  return row.usd;
}

export function getReservedScopeCostTotal(
  budgetId: string,
  windowStart: number,
  now = Date.now()
): number {
  const row = getDbInstance()
    .prepare(
      `SELECT COALESCE(SUM(r.usd), 0) AS usd FROM budget_inflight r
    JOIN budget_inflight_scopes s ON s.reservation_id = r.id
    WHERE s.budget_id = ? AND s.window_start = ? AND s.cap_key = '' AND r.expires_at > ?`
    )
    .get(budgetId, windowStart, now) as { usd: number };
  return row.usd;
}

export function reserveBudgetCost(
  id: string,
  keyId: string,
  usd: number,
  scopes: ReservationScope[],
  now = Date.now()
): void {
  const db = getDbInstance();
  db.prepare(
    "INSERT INTO budget_inflight(id, api_key_id, usd, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, keyId, usd, now, now + 60 * 60 * 1000);
  for (const scope of scopes)
    db.prepare(
      "INSERT OR IGNORE INTO budget_inflight_scopes(reservation_id, budget_id, scope_value, window_start, cap_key) VALUES (?, ?, ?, ?, ?)"
    ).run(id, scope.budgetId, scope.scopeValue, scope.windowStart, scope.capKey);
}

export function releaseBudgetCost(id: string): void {
  const db = getDbInstance();
  db.transaction(() => {
    db.prepare("DELETE FROM budget_inflight_scopes WHERE reservation_id = ?").run(id);
    db.prepare("DELETE FROM budget_inflight WHERE id = ?").run(id);
  })();
}
