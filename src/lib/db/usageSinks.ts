/** SQLite ownership for RedRouter's costed-usage webhook outbox. */
import { randomUUID } from "node:crypto";
import type { UsageSinkType } from "@/lib/usageSinks/transports/types";
import { getDbInstance } from "./core";

export type UsageSinkMode = "instant" | "window";
export type DeliveryStatus = "pending" | "sending" | "delivered" | "dead";

export interface UsageSink {
  id: string;
  name: string;
  type: UsageSinkType;
  /** Transport settings as stored: every credential field is encrypted. */
  config: Record<string, unknown>;
  /** Webhook sinks only (mirrors config.url / config.secret); '' for other transports. */
  url: string;
  secretEncrypted: string;
  mode: UsageSinkMode;
  windowSec: number | null;
  apiKeyIds: string[];
  enabled: boolean;
  cursorId: number;
  nextWindowEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostedUsageRow {
  id: number;
  apiKeyId: string;
  apiKeyName: string | null;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  amountUsd: number;
  success: boolean;
  timestamp: string;
  requestId: string | null;
}

export interface UsageDelivery {
  id: string;
  sinkId: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface UsageWindow {
  targetId: number;
  startAt: string;
  endAt: string;
  nextWindowEnd: string;
}

type Row = Record<string, unknown>;
const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown) => (typeof value === "number" ? value : Number(value) || 0);

function parseStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(asString(value) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseConfig(row: Row): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(asString(row.config) || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the legacy webhook columns.
  }
  return { url: asString(row.url), secret: asString(row.secret_encrypted) };
}

function mapSink(row: Row): UsageSink {
  return {
    id: asString(row.id),
    name: asString(row.name),
    type: (asString(row.type) || "webhook") as UsageSinkType,
    config: parseConfig(row),
    url: asString(row.url),
    secretEncrypted: asString(row.secret_encrypted),
    mode: row.mode === "window" ? "window" : "instant",
    windowSec: row.window_sec == null ? null : asNumber(row.window_sec),
    apiKeyIds: parseStringArray(row.api_key_ids),
    enabled: asNumber(row.enabled) === 1,
    cursorId: asNumber(row.cursor_id),
    nextWindowEnd: row.next_window_end == null ? null : asString(row.next_window_end),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapDelivery(row: Row): UsageDelivery {
  return {
    id: asString(row.id),
    sinkId: asString(row.sink_id),
    payload: JSON.parse(asString(row.payload)) as Record<string, unknown>,
    status: row.status as DeliveryStatus,
    attempts: asNumber(row.attempts),
    nextAttemptAt: row.next_attempt_at == null ? null : asString(row.next_attempt_at),
    lastStatus: row.last_status == null ? null : asNumber(row.last_status),
    lastError: row.last_error == null ? null : asString(row.last_error),
    deliveredAt: row.delivered_at == null ? null : asString(row.delivered_at),
    createdAt: asString(row.created_at),
  };
}

export function listUsageSinks(): UsageSink[] {
  return (
    getDbInstance()
      .prepare("SELECT * FROM redrouter_usage_sinks ORDER BY created_at")
      .all() as Row[]
  ).map(mapSink);
}

export function getUsageSink(id: string): UsageSink | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM redrouter_usage_sinks WHERE id = ?")
    .get(id) as Row | undefined;
  return row ? mapSink(row) : null;
}

/**
 * The legacy url / secret_encrypted columns keep mirroring a webhook sink's config (they are NOT
 * NULL); every other transport stores '' there and lives in `config` alone.
 */
function legacyWebhookColumns(
  type: UsageSinkType,
  config: Record<string, unknown>
): { url: string; secretEncrypted: string } {
  if (type !== "webhook") return { url: "", secretEncrypted: "" };
  return {
    url: typeof config.url === "string" ? config.url : "",
    secretEncrypted: typeof config.secret === "string" ? config.secret : "",
  };
}

/**
 * Create a sink. Pass `{ type, config }` (credential fields already encrypted), or the original
 * webhook-only `{ url, secretEncrypted }` form.
 */
export function createUsageSink(
  input: {
    name: string;
    mode: UsageSinkMode;
    windowSec?: number;
    apiKeyIds?: string[];
    enabled?: boolean;
  } & (
    | { type?: undefined; url: string; secretEncrypted: string }
    | { type: UsageSinkType; config: Record<string, unknown> }
  )
): UsageSink {
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  const head = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM request_cost_ledger").get() as {
    id: number;
  };
  const type: UsageSinkType = input.type ?? "webhook";
  const raw = input as { url?: string; secretEncrypted?: string; config?: Record<string, unknown> };
  const config: Record<string, unknown> =
    input.type === undefined ? { url: raw.url, secret: raw.secretEncrypted } : raw.config;
  const legacy = legacyWebhookColumns(type, config);
  db.prepare(
    `INSERT INTO redrouter_usage_sinks
      (id, name, type, config, url, secret_encrypted, mode, window_sec, api_key_ids, enabled,
       cursor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    type,
    JSON.stringify(config),
    legacy.url,
    legacy.secretEncrypted,
    input.mode,
    input.mode === "window" ? (input.windowSec ?? 900) : null,
    JSON.stringify(input.apiKeyIds ?? []),
    input.enabled ? 1 : 0,
    head.id,
    now,
    now
  );
  return getUsageSink(id) as UsageSink;
}

export function updateUsageSink(
  id: string,
  patch: {
    name?: string;
    /** Whole new config (credential fields already encrypted); the type never changes. */
    config?: Record<string, unknown>;
    /** Webhook-only shorthand, kept for the original API. */
    url?: string;
    secretEncrypted?: string;
    mode?: UsageSinkMode;
    windowSec?: number | null;
    enabled?: boolean;
    apiKeyIds?: string[];
  }
): UsageSink | null {
  const current = getUsageSink(id);
  if (!current) return null;
  const config: Record<string, unknown> =
    patch.config ??
    (current.type === "webhook" && (patch.url !== undefined || patch.secretEncrypted !== undefined)
      ? {
          ...current.config,
          url: patch.url ?? current.url,
          secret: patch.secretEncrypted ?? current.secretEncrypted,
        }
      : current.config);
  const legacy = legacyWebhookColumns(current.type, config);
  const mode = patch.mode ?? current.mode;
  const windowSec = mode === "window" ? (patch.windowSec ?? current.windowSec ?? 900) : null;
  // A new mode or window size starts a fresh schedule at the next boundary. The cursor is kept,
  // so nothing already recorded is skipped or sent twice; only an in-progress window's frozen
  // high-water mark is dropped.
  const rescheduled = mode !== current.mode || windowSec !== current.windowSec;
  const db = getDbInstance();
  db.transaction(() => {
    db.prepare(
      `UPDATE redrouter_usage_sinks SET name = ?, config = ?, url = ?,
      secret_encrypted = ?, mode = ?, window_sec = ?, enabled = ?, api_key_ids = ?,
      next_window_end = CASE WHEN ? THEN NULL ELSE next_window_end END, updated_at = ?
      WHERE id = ?`
    ).run(
      patch.name ?? current.name,
      JSON.stringify(config),
      legacy.url,
      legacy.secretEncrypted,
      mode,
      windowSec,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      JSON.stringify(patch.apiKeyIds ?? current.apiKeyIds),
      rescheduled ? 1 : 0,
      new Date().toISOString(),
      id
    );
    if (rescheduled) db.prepare("DELETE FROM redrouter_usage_windows WHERE sink_id = ?").run(id);
  })();
  return getUsageSink(id);
}

export function deleteUsageSink(id: string): boolean {
  const db = getDbInstance();
  return db.transaction(() => {
    db.prepare("DELETE FROM redrouter_usage_windows WHERE sink_id = ?").run(id);
    db.prepare("DELETE FROM redrouter_usage_deliveries WHERE sink_id = ?").run(id);
    return db.prepare("DELETE FROM redrouter_usage_sinks WHERE id = ?").run(id).changes > 0;
  })();
}

export function listCostedUsageAfter(
  cursorId: number,
  limit: number,
  upToId?: number
): CostedUsageRow[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT l.id, l.api_key_id, k.name AS api_key_name,
      l.provider, l.model, l.tokens_input, l.tokens_output, l.tokens_cache_read,
      l.amount_usd, l.success, l.timestamp, l.request_id
      FROM request_cost_ledger l LEFT JOIN api_keys k ON k.id = l.api_key_id
      WHERE l.id > ? AND l.id <= ? ORDER BY l.id LIMIT ?`
    )
    .all(cursorId, upToId ?? Number.MAX_SAFE_INTEGER, limit) as Row[];
  return rows.map((row) => ({
    id: asNumber(row.id),
    apiKeyId: asString(row.api_key_id),
    apiKeyName: row.api_key_name == null ? null : asString(row.api_key_name),
    provider: asString(row.provider),
    model: asString(row.model),
    tokensInput: asNumber(row.tokens_input),
    tokensOutput: asNumber(row.tokens_output),
    tokensCacheRead: asNumber(row.tokens_cache_read),
    amountUsd: asNumber(row.amount_usd),
    success: asNumber(row.success) === 1,
    timestamp: asString(row.timestamp),
    requestId: row.request_id == null ? null : asString(row.request_id),
  }));
}

/** Atomic cursor/outbox commit prevents loss after a crash and dedupes overlapping ticks. */
export function commitUsageBatch(
  sinkId: string,
  expectedCursor: number,
  nextCursor: number,
  deliveries: Array<{ id: string; payload: Record<string, unknown> }>,
  nextWindowEnd?: string,
  completeWindow = false
): boolean {
  const db = getDbInstance();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE redrouter_usage_sinks SET cursor_id = ?,
        next_window_end = COALESCE(?, next_window_end), updated_at = ?
        WHERE id = ? AND cursor_id = ? AND enabled = 1`
      )
      .run(nextCursor, nextWindowEnd ?? null, now, sinkId, expectedCursor);
    if (result.changes !== 1) return false;
    const insert = db.prepare(`INSERT OR IGNORE INTO redrouter_usage_deliveries
      (id, sink_id, payload, status, next_attempt_at, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`);
    for (const delivery of deliveries) {
      insert.run(delivery.id, sinkId, JSON.stringify(delivery.payload), now, now);
    }
    if (completeWindow) {
      db.prepare("DELETE FROM redrouter_usage_windows WHERE sink_id = ?").run(sinkId);
    }
    return true;
  })();
}

function mapWindow(row: Row): UsageWindow {
  return {
    targetId: asNumber(row.target_id),
    startAt: asString(row.start_at),
    endAt: asString(row.end_at),
    nextWindowEnd: asString(row.next_window_end),
  };
}

/** First closer fixes the ledger high-water mark; later ticks resume the same window. */
export function getOrStartUsageWindow(
  sinkId: string,
  expectedBoundary: string,
  startAt: string,
  endAt: string,
  nextWindowEnd: string
): UsageWindow | null {
  const db = getDbInstance();
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT * FROM redrouter_usage_windows WHERE sink_id = ?")
      .get(sinkId) as Row | undefined;
    if (existing) return mapWindow(existing);
    const sink = db
      .prepare(
        `SELECT next_window_end, enabled FROM redrouter_usage_sinks
      WHERE id = ?`
      )
      .get(sinkId) as Row | undefined;
    if (!sink || sink.next_window_end !== expectedBoundary || asNumber(sink.enabled) !== 1) {
      return null;
    }
    const head = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM request_cost_ledger").get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO redrouter_usage_windows
      (sink_id, target_id, start_at, end_at, next_window_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sinkId, head.id, startAt, endAt, nextWindowEnd, new Date().toISOString());
    return { targetId: head.id, startAt, endAt, nextWindowEnd };
  })();
}

export function setNextUsageWindow(id: string, boundary: string): void {
  getDbInstance()
    .prepare(
      `UPDATE redrouter_usage_sinks SET next_window_end = ?
    WHERE id = ? AND next_window_end IS NULL`
    )
    .run(boundary, id);
}

export function listDueUsageDeliveries(now: string, limit = 20): UsageDelivery[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT d.* FROM redrouter_usage_deliveries d
    JOIN redrouter_usage_sinks s ON s.id = d.sink_id
    WHERE s.enabled = 1 AND ((d.status = 'pending' AND d.next_attempt_at <= ?)
      OR (d.status = 'sending' AND d.lease_until <= ?))
    ORDER BY d.created_at LIMIT ?`
    )
    .all(now, now, limit) as Row[];
  return rows.map(mapDelivery);
}

/** Claim with a lease. Two processes may see a due row, only one can send it. */
export function claimUsageDelivery(id: string, now: string, leaseUntil: string): boolean {
  return (
    getDbInstance()
      .prepare(
        `UPDATE redrouter_usage_deliveries
    SET status = 'sending', lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?)
      OR (status = 'sending' AND lease_until <= ?))`
      )
      .run(leaseUntil, id, now, now).changes === 1
  );
}

export function finishUsageDelivery(
  id: string,
  leaseUntil: string,
  input: {
    status: "pending" | "delivered" | "dead";
    nextAttemptAt: string | null;
    httpStatus: number | null;
    error: string | null;
    deliveredAt: string | null;
  }
): boolean {
  return (
    getDbInstance()
      .prepare(
        `UPDATE redrouter_usage_deliveries SET status = ?,
    next_attempt_at = ?, lease_until = NULL, last_status = ?, last_error = ?, delivered_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until = ?`
      )
      .run(
        input.status,
        input.nextAttemptAt,
        input.httpStatus,
        input.error,
        input.deliveredAt,
        id,
        leaseUntil
      ).changes === 1
  );
}

export function listUsageDeliveries(sinkId: string, limit = 50): UsageDelivery[] {
  return (
    getDbInstance()
      .prepare(
        `SELECT * FROM redrouter_usage_deliveries
    WHERE sink_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(sinkId, Math.min(Math.max(limit, 1), 100)) as Row[]
  ).map(mapDelivery);
}

export type DeliveryStatusFilter = DeliveryStatus | "failed";

/** One page of a sink's deliveries, newest first. `failed` is the UI name for `dead`. */
export function listUsageDeliveriesPage(
  sinkId: string,
  options: { limit?: number; offset?: number; status?: DeliveryStatusFilter } = {}
): { deliveries: UsageDelivery[]; total: number } {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const status = options.status === "failed" ? "dead" : options.status;
  const db = getDbInstance();
  const filter = status ? "AND status = ?" : "";
  const args: unknown[] = status ? [sinkId, status] : [sinkId];
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM redrouter_usage_deliveries WHERE sink_id = ? ${filter}`)
      .get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM redrouter_usage_deliveries WHERE sink_id = ? ${filter}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Row[];
  return { deliveries: rows.map(mapDelivery), total: asNumber(total) };
}

export function getUsageDelivery(sinkId: string, id: string): UsageDelivery | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM redrouter_usage_deliveries WHERE id = ? AND sink_id = ?")
    .get(id, sinkId) as Row | undefined;
  return row ? mapDelivery(row) : null;
}

/**
 * Make one delivery due right now, for a manual retry. A dead delivery gets a fresh retry budget;
 * a pending one keeps its attempt count. A delivered one, or one another worker holds a live
 * lease on, is left alone (false). The delivery keeps its id, so the receiver can still dedupe.
 */
export function requeueUsageDelivery(sinkId: string, id: string, now: string): boolean {
  return (
    getDbInstance()
      .prepare(
        `UPDATE redrouter_usage_deliveries
    SET status = 'pending', next_attempt_at = ?, lease_until = NULL,
        attempts = CASE WHEN status = 'dead' THEN 0 ELSE attempts END
    WHERE id = ? AND sink_id = ?
      AND (status IN ('pending', 'dead') OR (status = 'sending' AND lease_until <= ?))`
      )
      .run(now, id, sinkId, now).changes === 1
  );
}

/** Delivery counts per sink for the dashboard list (`sending` counts as pending). */
export function getUsageDeliveryStats(): Record<
  string,
  { pending: number; delivered: number; dead: number }
> {
  const rows = getDbInstance()
    .prepare(
      `SELECT sink_id, status, COUNT(*) AS n FROM redrouter_usage_deliveries
      GROUP BY sink_id, status`
    )
    .all() as Row[];
  const stats: Record<string, { pending: number; delivered: number; dead: number }> = {};
  for (const row of rows) {
    const sinkId = asString(row.sink_id);
    stats[sinkId] ||= { pending: 0, delivered: 0, dead: 0 };
    const bucket =
      row.status === "delivered" ? "delivered" : row.status === "dead" ? "dead" : "pending";
    stats[sinkId][bucket] += asNumber(row.n);
  }
  return stats;
}
