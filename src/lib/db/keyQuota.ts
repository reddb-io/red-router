/**
 * db/keyQuota.ts — Per-API-key tpm/rpm/daily-token/monthly-amount quota.
 *
 * KISS counter + threshold quota: a single config row on `api_key_quota_limits`
 * (tpm / rpm / daily tokens / monthly USD) plus 2-bucket sliding-window counters on
 * `api_key_quota_counters` for tpm & rpm. The monthly amount is not counted
 * here — it is read from the cost ledger's current-calendar-month SUM
 * (`aggregateLedgerThisMonth`). Daily tokens are likewise read from the
 * current UTC calendar day in the ledger.
 *
 * A NULL limit means "unlimited" (0 is normalized to unlimited on read).
 *
 * @module db/keyQuota
 */

import { getDbInstance } from "./core";
import { aggregateLedgerThisMonth } from "./costLedger";
import { toNumber } from "@/shared/utils/numeric";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyQuotaLimits {
  apiKeyId: string;
  /** Tokens per minute; null/0 = unlimited. */
  tpmLimit: number | null;
  /** Requests per minute; null/0 = unlimited. */
  rpmLimit: number | null;
  /** UTC calendar-day input + output token cap; null/0 = unlimited. */
  dailyTokensLimit: number | null;
  /** Calendar-month USD spend cap; null/0 = unlimited. */
  monthlyAmountUsd: number | null;
}

export interface KeyQuotaCounters {
  /** Effective tokens used in the current minute window. */
  tpmUsed: number;
  /** Effective requests used in the current minute window. */
  rpmUsed: number;
  /** UTC calendar-day tokens, only queried when the limit is configured. */
  dailyTokensUsed: number | null;
  /** Calendar-month USD spend (from the cost ledger). */
  monthlyAmountUsd: number;
}

export interface KeyQuotaStatus {
  enabled: boolean;
  limits: KeyQuotaLimits;
  counters: KeyQuotaCounters;
  tpmExceeded: boolean;
  rpmExceeded: boolean;
  dailyTokensExceeded: boolean;
  monthlyExceeded: boolean;
  /** ISO timestamp the current minute window ends. */
  windowResetAtIso: string;
}

export type KeyQuotaDimension = "tpm" | "rpm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 2-bucket sliding window over a 60s fixed window. */
export const KEY_QUOTA_WINDOW_MS = 60_000;

/** dimension_key fragment for the counters table. */
const DIMENSION_TPM = "key-quota:tpm";
const DIMENSION_RPM = "key-quota:rpm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** NULL or <=0 reads as unlimited → null. */
function toLimitOrNull(value: unknown): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

/** Convert a limit back to a null-safe string for the DB (NULL stores unlimited). */
function limitToDb(value: number | null | undefined): number | null {
  if (value === undefined) return null;
  return value !== null && value > 0 ? value : null;
}

function toIsoWindowStart(nowMs: number): string {
  const windowStart = Math.floor(nowMs / KEY_QUOTA_WINDOW_MS) * KEY_QUOTA_WINDOW_MS;
  return new Date(windowStart).toISOString();
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

function rowToLimits(row: unknown): KeyQuotaLimits {
  const r = asRecord(row);
  return {
    apiKeyId: typeof r.api_key_id === "string" ? r.api_key_id : "",
    tpmLimit: toLimitOrNull(r.tpm_limit),
    rpmLimit: toLimitOrNull(r.rpm_limit),
    dailyTokensLimit: toLimitOrNull(r.daily_tokens_limit),
    monthlyAmountUsd: toLimitOrNull(r.monthly_amount_usd),
  };
}

/**
 * Load quota limits for a key. Returns all-null limits when no row exists.
 */
export function getKeyQuotaLimits(apiKeyId: string): KeyQuotaLimits {
  if (!apiKeyId)
    return {
      apiKeyId,
      tpmLimit: null,
      rpmLimit: null,
      dailyTokensLimit: null,
      monthlyAmountUsd: null,
    };
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT q.api_key_id, q.tpm_limit, q.rpm_limit, d.daily_tokens_limit,
              q.monthly_amount_usd
       FROM api_key_quota_limits q
       LEFT JOIN api_key_daily_token_limits d ON d.api_key_id = q.api_key_id
       WHERE q.api_key_id = ?`
    )
    .get(apiKeyId);
  return row
    ? rowToLimits(row)
    : { apiKeyId, tpmLimit: null, rpmLimit: null, dailyTokensLimit: null, monthlyAmountUsd: null };
}

/** Batch limits for administrative listings without per-key SQLite queries. */
export function getKeyQuotaLimitsMany(apiKeyIds: readonly string[]): Map<string, KeyQuotaLimits> {
  const result = new Map<string, KeyQuotaLimits>(
    apiKeyIds.map((apiKeyId) => [
      apiKeyId,
      { apiKeyId, tpmLimit: null, rpmLimit: null, dailyTokensLimit: null, monthlyAmountUsd: null },
    ])
  );
  if (apiKeyIds.length === 0) return result;
  const db = getDbInstance();
  for (let offset = 0; offset < apiKeyIds.length; offset += 400) {
    const chunk = apiKeyIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT q.api_key_id, q.tpm_limit, q.rpm_limit, d.daily_tokens_limit,
                q.monthly_amount_usd
         FROM api_key_quota_limits q
         LEFT JOIN api_key_daily_token_limits d ON d.api_key_id = q.api_key_id
         WHERE q.api_key_id IN (${placeholders})`
      )
      .all(...chunk);
    for (const row of rows) {
      const limits = rowToLimits(row);
      result.set(limits.apiKeyId, limits);
    }
  }
  return result;
}

export interface UpsertKeyQuotaLimitsInput {
  tpmLimit?: number | null;
  rpmLimit?: number | null;
  dailyTokensLimit?: number | null;
  monthlyAmountUsd?: number | null;
}

/** Validate and copy before the asynchronous bearer-key generation begins. */
export function snapshotInitialKeyQuotaLimits(input?: UpsertKeyQuotaLimitsInput) {
  if (!input) return undefined;
  const limits = { ...input };
  for (const [dimension, value] of Object.entries(limits)) {
    if (
      dimension !== "tpmLimit" &&
      dimension !== "rpmLimit" &&
      dimension !== "dailyTokensLimit" &&
      dimension !== "monthlyAmountUsd"
    ) {
      throw new Error(`Unknown API key quota dimension: ${dimension}`);
    }
    if (value === null || value === undefined || value === 0) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (dimension !== "monthlyAmountUsd" && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Invalid API key quota limit: ${dimension}`);
    }
  }
  return limits;
}

function writeQuotaLimits(
  db: ReturnType<typeof getDbInstance>,
  apiKeyId: string,
  limits: Omit<KeyQuotaLimits, "apiKeyId">
): void {
  db.prepare(
    `INSERT INTO api_key_quota_limits (api_key_id, tpm_limit, rpm_limit, monthly_amount_usd, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id) DO UPDATE SET
       tpm_limit = excluded.tpm_limit,
       rpm_limit = excluded.rpm_limit,
       monthly_amount_usd = excluded.monthly_amount_usd,
       updated_at = excluded.updated_at`
  ).run(apiKeyId, limits.tpmLimit, limits.rpmLimit, limits.monthlyAmountUsd);
  if (limits.dailyTokensLimit === null) {
    db.prepare("DELETE FROM api_key_daily_token_limits WHERE api_key_id = ?").run(apiKeyId);
  } else {
    db.prepare(
      `INSERT INTO api_key_daily_token_limits (api_key_id, daily_tokens_limit, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(api_key_id) DO UPDATE SET
         daily_tokens_limit = excluded.daily_tokens_limit,
         updated_at = excluded.updated_at`
    ).run(apiKeyId, limits.dailyTokensLimit);
  }
}

/** Caller must already own a SQLite transaction with the newly inserted key. */
export function insertInitialKeyQuotaLimitsInTransaction(
  apiKeyId: string,
  input: UpsertKeyQuotaLimitsInput
): void {
  const db = getDbInstance();
  writeQuotaLimits(db, apiKeyId, {
    tpmLimit: limitToDb(input.tpmLimit),
    rpmLimit: limitToDb(input.rpmLimit),
    dailyTokensLimit: limitToDb(input.dailyTokensLimit),
    monthlyAmountUsd: limitToDb(input.monthlyAmountUsd),
  });
}

/**
 * Upsert quota limits for a key. Omitted fields keep their existing value.
 * Returns the resulting limits.
 */
export function upsertKeyQuotaLimits(
  apiKeyId: string,
  input: UpsertKeyQuotaLimitsInput
): KeyQuotaLimits {
  if (!apiKeyId)
    return {
      apiKeyId,
      tpmLimit: null,
      rpmLimit: null,
      dailyTokensLimit: null,
      monthlyAmountUsd: null,
    };

  const db = getDbInstance();
  const existing = getKeyQuotaLimits(apiKeyId);
  const tpm = limitToDb(input.tpmLimit !== undefined ? input.tpmLimit : existing.tpmLimit);
  const rpm = limitToDb(input.rpmLimit !== undefined ? input.rpmLimit : existing.rpmLimit);
  const dailyTokens = limitToDb(
    input.dailyTokensLimit !== undefined ? input.dailyTokensLimit : existing.dailyTokensLimit
  );
  const monthly = limitToDb(
    input.monthlyAmountUsd !== undefined ? input.monthlyAmountUsd : existing.monthlyAmountUsd
  );

  db.transaction(() =>
    writeQuotaLimits(db, apiKeyId, {
      tpmLimit: tpm,
      rpmLimit: rpm,
      dailyTokensLimit: dailyTokens,
      monthlyAmountUsd: monthly,
    })
  )();

  return {
    apiKeyId,
    tpmLimit: tpm,
    rpmLimit: rpm,
    dailyTokensLimit: dailyTokens,
    monthlyAmountUsd: monthly,
  };
}

export function clearKeyQuotaLimits(apiKeyId: string): void {
  if (!apiKeyId) return;
  const db = getDbInstance();
  db.transaction(() => {
    db.prepare("DELETE FROM api_key_quota_limits WHERE api_key_id = ?").run(apiKeyId);
    db.prepare("DELETE FROM api_key_daily_token_limits WHERE api_key_id = ?").run(apiKeyId);
    db.prepare("DELETE FROM api_key_quota_counters WHERE api_key_id = ?").run(apiKeyId);
  })();
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function bucketIndex(nowMs: number): number {
  return Math.floor(nowMs / KEY_QUOTA_WINDOW_MS);
}

function getBucketCount(apiKeyId: string, dimensionKey: string, bucket: number): number {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT consumed FROM api_key_quota_counters
       WHERE api_key_id = ? AND dimension_key = ? AND bucket_index = ?`
    )
    .get(apiKeyId, dimensionKey, bucket) as { consumed?: number } | undefined;
  return toNumber(row?.consumed);
}

/**
 * Effective count for a 2-bucket sliding window:
 *   effective = prev × (1 − elapsed/window) + curr
 */
function effectiveWindowCount(apiKeyId: string, dimensionKey: string, nowMs: number): number {
  const current = bucketIndex(nowMs);
  const prev = current - 1;
  const curr = getBucketCount(apiKeyId, dimensionKey, current);
  const prevCount = getBucketCount(apiKeyId, dimensionKey, prev);
  const elapsed = nowMs - current * KEY_QUOTA_WINDOW_MS;
  const weight = Math.max(0, Math.min(1, elapsed / KEY_QUOTA_WINDOW_MS));
  return prevCount * (1 - weight) + curr;
}

/**
 * Atomically add `delta` to the current window bucket of any counter (UPSERT). `ownerId` and
 * `dimensionKey` are the table's first two key columns; the budgets engine uses owner
 * `budget:<id>` so its rate counters share this table and never collide with a real key id.
 */
export function incrementQuotaBucket(
  ownerId: string,
  dimensionKey: string,
  delta: number,
  nowMs = Date.now()
): void {
  if (!ownerId || !(delta > 0)) return;
  getDbInstance()
    .prepare(
      `INSERT INTO api_key_quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(api_key_id, dimension_key, bucket_index) DO UPDATE SET
       consumed = consumed + excluded.consumed,
       updated_at = excluded.updated_at`
    )
    .run(ownerId, dimensionKey, bucketIndex(nowMs), delta, nowMs);
}

/** Sliding-window effective count of any counter written by {@link incrementQuotaBucket}. */
export function getQuotaWindowCount(
  ownerId: string,
  dimensionKey: string,
  nowMs = Date.now()
): number {
  return effectiveWindowCount(ownerId, dimensionKey, nowMs);
}

/** Drop every counter of one owner (a deleted budget). */
export function clearQuotaCounters(ownerId: string): void {
  if (!ownerId) return;
  getDbInstance().prepare("DELETE FROM api_key_quota_counters WHERE api_key_id = ?").run(ownerId);
}

/**
 * Atomically add `delta` to the current window bucket (UPSERT).
 */
export function incrementKeyQuotaCounter(
  apiKeyId: string,
  dimension: KeyQuotaDimension,
  delta: number,
  nowMs = Date.now()
): void {
  if (!apiKeyId || delta <= 0) return;
  incrementQuotaBucket(apiKeyId, dimension === "tpm" ? DIMENSION_TPM : DIMENSION_RPM, delta, nowMs);
}

/**
 * Increment both tpm (by billable tokens) and rpm (by 1) for a completed call.
 */
export function recordKeyQuotaUsage(
  apiKeyId: string,
  billableTokens: number,
  nowMs = Date.now()
): void {
  if (!apiKeyId) return;
  if (billableTokens > 0) incrementKeyQuotaCounter(apiKeyId, "tpm", billableTokens, nowMs);
  incrementKeyQuotaCounter(apiKeyId, "rpm", 1, nowMs);
}

// ---------------------------------------------------------------------------
// Status / enforcement read
// ---------------------------------------------------------------------------

/**
 * Effective usage in the current windows plus the month ledger total.
 */
export function getKeyQuotaCounters(
  apiKeyId: string,
  deps: { now?: () => number; monthTotalUsd?: number } = {}
): KeyQuotaCounters {
  const nowMs = (deps.now ?? Date.now)();
  return {
    tpmUsed: effectiveWindowCount(apiKeyId, DIMENSION_TPM, nowMs),
    rpmUsed: effectiveWindowCount(apiKeyId, DIMENSION_RPM, nowMs),
    dailyTokensUsed: null,
    monthlyAmountUsd:
      deps.monthTotalUsd !== undefined ? deps.monthTotalUsd : getLedgerMonthTotal(apiKeyId, nowMs),
  };
}

/**
 * Resolve the current calendar-month ledger total for a key, with a lazy
 * dynamic import to avoid a hard module cycle cost on cold starts.
 */
function getLedgerMonthTotal(apiKeyId: string, nowMs: number): number {
  try {
    return aggregateLedgerThisMonth(apiKeyId, new Date(nowMs).toISOString()).amountUsd;
  } catch {
    return 0;
  }
}

function getLedgerDayTokenTotal(apiKeyId: string, nowMs: number): number {
  const dayStartMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const dayStartIso = new Date(dayStartMs).toISOString();
  const nextDayIso = new Date(dayStartMs + 86_400_000).toISOString();
  const row = getDbInstance()
    .prepare(
      `SELECT COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens
       FROM request_cost_ledger
       WHERE api_key_id = ? AND timestamp >= ? AND timestamp < ?`
    )
    .get(apiKeyId, dayStartIso, nextDayIso) as { tokens?: number } | undefined;
  return toNumber(row?.tokens);
}

/**
 * Full enforcement-ready status for a key: limits, current usage, and per
 * dimension exceeded flags.
 */
export function getKeyQuotaStatus(
  apiKeyId: string,
  deps: { now?: () => number; monthTotalUsd?: number; dailyTokensUsed?: number } = {}
): KeyQuotaStatus {
  const limits = getKeyQuotaLimits(apiKeyId);
  const counters = getKeyQuotaCounters(apiKeyId, deps);
  const nowMs = (deps.now ?? Date.now)();
  if (limits.dailyTokensLimit !== null) {
    counters.dailyTokensUsed = deps.dailyTokensUsed ?? getLedgerDayTokenTotal(apiKeyId, nowMs);
  }
  const enabled =
    limits.tpmLimit !== null ||
    limits.rpmLimit !== null ||
    limits.dailyTokensLimit !== null ||
    limits.monthlyAmountUsd !== null;

  return {
    enabled,
    limits,
    counters,
    tpmExceeded: enabled && limits.tpmLimit !== null && counters.tpmUsed >= limits.tpmLimit,
    rpmExceeded: enabled && limits.rpmLimit !== null && counters.rpmUsed >= limits.rpmLimit,
    dailyTokensExceeded:
      limits.dailyTokensLimit !== null &&
      counters.dailyTokensUsed !== null &&
      counters.dailyTokensUsed >= limits.dailyTokensLimit,
    monthlyExceeded:
      enabled &&
      limits.monthlyAmountUsd !== null &&
      counters.monthlyAmountUsd >= limits.monthlyAmountUsd,
    windowResetAtIso: toIsoWindowStart(nowMs + KEY_QUOTA_WINDOW_MS),
  };
}
