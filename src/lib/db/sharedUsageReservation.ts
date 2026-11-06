/** Shared, durable pre-dispatch reservations. Not wired into request handling. */
type Statement = { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
export type ReservationDatabase = {
  driver: string;
  immediate(fn: () => void): void;
  prepare(sql: string): Statement;
};
export type UsageReservation = {
  id: string;
  keyId: string;
  tokens: number;
  usd: number;
  nowMs: number;
};

function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid usage reservation value");
  return value;
}

/**
 * A reservation is an upper bound, not a token estimate. Unknown usage must
 * remain reserved after dispatch until it is reconciled; it never expires.
 */
export function reserveUsageOnDb(db: ReservationDatabase, r: UsageReservation): boolean {
  if (db.driver === "sql.js") throw new Error("Shared reservations require a SQLite file");
  if (!r.id || r.id.length > 128 || !r.keyId || r.keyId.length > 512 ||
      !Number.isSafeInteger(r.nowMs) || r.nowMs < 946_684_800_000 || r.nowMs >= 4_102_444_800_000 ||
      !Number.isSafeInteger(r.tokens) || r.tokens < 0) throw new Error("Invalid usage reservation");
  nonnegative(r.usd);
  const date = new Date(r.nowMs);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
  const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  const bucket = Math.floor(r.nowMs / 60_000);
  let allowed = false;
  db.immediate(() => {
    const limits = db.prepare("SELECT tpm_limit, monthly_amount_usd FROM api_key_quota_limits WHERE api_key_id = ?").get(r.keyId) as { tpm_limit?: number | null; monthly_amount_usd?: number | null } | undefined;
    const daily = db.prepare("SELECT daily_tokens_limit FROM api_key_daily_token_limits WHERE api_key_id = ?").get(r.keyId) as { daily_tokens_limit?: number | null } | undefined;
    const tpmLimit = limits?.tpm_limit == null ? 0 : nonnegative(limits.tpm_limit);
    const usdLimit = limits?.monthly_amount_usd == null ? 0 : nonnegative(limits.monthly_amount_usd);
    const dayLimit = daily?.daily_tokens_limit == null ? 0 : nonnegative(daily.daily_tokens_limit);
    const outstanding = db.prepare("SELECT COALESCE(SUM(reserved_tokens),0) AS tokens, COALESCE(SUM(reserved_usd),0) AS usd FROM api_key_usage_reservations WHERE api_key_id = ?").get(r.keyId) as { tokens: number; usd: number };
    const counters = db.prepare("SELECT COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END),0) AS current, COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END),0) AS previous FROM api_key_quota_counters WHERE api_key_id = ? AND dimension_key = 'key-quota:tpm' AND bucket_index IN (?, ?)").get(bucket, bucket - 1, r.keyId, bucket, bucket - 1) as { current: number; previous: number };
    const ledger = db.prepare("SELECT COALESCE(SUM(CASE WHEN timestamp >= ? THEN tokens_input + tokens_output ELSE 0 END),0) AS tokens, COALESCE(SUM(CASE WHEN timestamp >= ? AND success = 1 THEN amount_usd ELSE 0 END),0) AS usd FROM request_cost_ledger WHERE api_key_id = ?").get(day, month, r.keyId) as { tokens: number; usd: number };
    const reservedTokens = nonnegative(outstanding.tokens), reservedUsd = nonnegative(outstanding.usd);
    const usedTpm = nonnegative(counters.current) + nonnegative(counters.previous) * (1 - (r.nowMs % 60_000) / 60_000);
    const dayTokens = nonnegative(ledger.tokens), monthUsd = nonnegative(ledger.usd);
    if ((tpmLimit > 0 && usedTpm + reservedTokens + r.tokens > tpmLimit) ||
        (dayLimit > 0 && dayTokens + reservedTokens + r.tokens > dayLimit) ||
        (usdLimit > 0 && monthUsd + reservedUsd + r.usd > usdLimit)) return;
    db.prepare("INSERT INTO api_key_usage_reservations(id, api_key_id, reserved_tokens, reserved_usd, created_at, state) VALUES (?, ?, ?, ?, ?, 'reserved')")
      .run(r.id, r.keyId, r.tokens, r.usd, r.nowMs);
    allowed = true;
  });
  return allowed;
}

/** Dispatch is durable before sending; failures thereafter retain the charge. */
export function markUsageDispatchedOnDb(db: ReservationDatabase, id: string, keyId: string): boolean {
  let changed = false;
  db.immediate(() => {
    const row = db.prepare("SELECT state FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ?").get(id, keyId) as { state?: string } | undefined;
    if (!row || (row.state !== "reserved" && row.state !== "dispatched")) return;
    db.prepare("UPDATE api_key_usage_reservations SET state = 'dispatched' WHERE id = ? AND api_key_id = ?").run(id, keyId);
    changed = true;
  });
  return changed;
}

/** Cancel only before dispatch. An uncertain dispatched request stays reserved. */
export function cancelUndispatchedUsageOnDb(db: ReservationDatabase, id: string, keyId: string): boolean {
  let removed = false;
  db.immediate(() => {
    const row = db.prepare("SELECT state FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ?").get(id, keyId) as { state?: string } | undefined;
    if (row?.state !== "reserved") return;
    db.prepare("DELETE FROM api_key_usage_reservations WHERE id = ? AND api_key_id = ? AND state = 'reserved'").run(id, keyId);
    removed = true;
  });
  return removed;
}
