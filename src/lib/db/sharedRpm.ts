/**
 * SQLite transaction shared by the TypeScript proxy and the Rust gateway.
 * Uses the product's weighted two-bucket, 60-second RPM window.
 */
type SqliteStatement = {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
};
type SharedRpmDatabase = {
  driver: string;
  immediate(fn: () => void): void;
  prepare(sql: string): SqliteStatement;
};

export function reserveSharedRpmOnDb(
  db: SharedRpmDatabase,
  apiKeyId: string,
  nowMs = Date.now()
): boolean {
  if (!apiKeyId || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid shared RPM reservation");
  if (db.driver === "sql.js") throw new Error("Shared RPM requires a shared SQLite file");
  const bucket = Math.floor(nowMs / 60_000);
  let allowed = false;
  db.immediate(() => {
    const limitRow = db
      .prepare("SELECT rpm_limit FROM api_key_quota_limits WHERE api_key_id = ?")
      .get(apiKeyId) as { rpm_limit?: number | null } | undefined;
    const rawLimit = limitRow?.rpm_limit;
    if (rawLimit != null && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)))
      throw new Error("Invalid shared RPM limit");
    const row = db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END), 0) AS current,
          COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END), 0) AS previous
        FROM api_key_quota_counters
        WHERE api_key_id = ? AND dimension_key = 'key-quota:rpm' AND bucket_index IN (?, ?)`
      )
      .get(bucket, bucket - 1, apiKeyId, bucket, bucket - 1) as {
      current: number;
      previous: number;
    };
    if (
      !Number.isFinite(row.current) ||
      !Number.isFinite(row.previous) ||
      row.current < 0 ||
      row.previous < 0
    )
      throw new Error("Invalid shared RPM counter");
    const used = row.current + row.previous * (1 - (nowMs % 60_000) / 60_000);
    if (rawLimit != null && rawLimit > 0 && used >= rawLimit) return;
    db.prepare(
      `INSERT INTO api_key_quota_counters
        (api_key_id, dimension_key, bucket_index, consumed, updated_at)
      VALUES (?, 'key-quota:rpm', ?, 1, ?)
      ON CONFLICT(api_key_id, dimension_key, bucket_index) DO UPDATE SET
        consumed = consumed + 1, updated_at = excluded.updated_at`
    ).run(apiKeyId, bucket, nowMs);
    allowed = true;
  });
  return allowed;
}
