/** SQLite ownership for RedRouter's costed-usage webhook outbox. */
import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

export type UsageSinkMode = "instant" | "window";
export type DeliveryStatus = "pending" | "sending" | "delivered" | "dead";

export interface UsageSink {
  id: string;
  name: string;
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

function mapSink(row: Row): UsageSink {
  return {
    id: asString(row.id),
    name: asString(row.name),
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

export function createUsageSink(input: {
  name: string;
  url: string;
  secretEncrypted: string;
  mode: UsageSinkMode;
  windowSec?: number;
  apiKeyIds?: string[];
  enabled?: boolean;
}): UsageSink {
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  const head = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM request_cost_ledger").get() as {
    id: number;
  };
  db.prepare(
    `INSERT INTO redrouter_usage_sinks
      (id, name, url, secret_encrypted, mode, window_sec, api_key_ids, enabled,
       cursor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.url,
    input.secretEncrypted,
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
    url?: string;
    secretEncrypted?: string;
    enabled?: boolean;
    apiKeyIds?: string[];
  }
): UsageSink | null {
  const current = getUsageSink(id);
  if (!current) return null;
  getDbInstance()
    .prepare(
      `UPDATE redrouter_usage_sinks SET name = ?, url = ?,
      secret_encrypted = ?, enabled = ?, api_key_ids = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      patch.name ?? current.name,
      patch.url ?? current.url,
      patch.secretEncrypted ?? current.secretEncrypted,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      JSON.stringify(patch.apiKeyIds ?? current.apiKeyIds),
      new Date().toISOString(),
      id
    );
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
