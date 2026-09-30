/**
 * db/guardrailEvents.ts — Guardrail monitoring events (migration 204).
 *
 * One row per block / flag / mask. Rows hold guardrail and rule ids only, never matched text.
 * Recording is fire-and-forget: it can throw nowhere the request can see. Rows older than
 * `GUARDRAIL_EVENT_RETENTION_MS` are pruned opportunistically by the writer, at most once an hour.
 *
 * @module db/guardrailEvents
 */

import { getDbInstance } from "./core";

export const GUARDRAIL_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const GUARDRAIL_EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const GUARDRAIL_EVENT_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type GuardrailEventStage = "request" | "response";
export type GuardrailEventAction = "block" | "flag" | "mask";

export interface GuardrailEventRecord {
  guardrailId: string;
  stage: GuardrailEventStage;
  action: GuardrailEventAction;
  apiKeyId?: string | null;
  requestId?: string | null;
  ruleId?: string | null;
  /** Epoch ms; defaults to now. */
  ts?: number;
}

export interface GuardrailEventRow {
  id: number;
  ts: number;
  guardrailId: string;
  stage: GuardrailEventStage;
  action: GuardrailEventAction;
  apiKeyId: string | null;
  requestId: string | null;
  ruleId: string | null;
}

export interface GuardrailEventCounts {
  guardrailId: string;
  block: number;
  flag: number;
  mask: number;
  total: number;
}

let lastPruneAt = 0;

/** Test hook: forget when the last prune ran. */
export function resetGuardrailEventPruneClock(): void {
  lastPruneAt = 0;
}

/** Deletes events past retention. Returns how many rows went. */
export function pruneGuardrailEvents(now = Date.now()): number {
  const result = getDbInstance()
    .prepare("DELETE FROM guardrail_events WHERE ts < ?")
    .run(now - GUARDRAIL_EVENT_RETENTION_MS);
  return Number(result.changes ?? 0);
}

/**
 * Stores one event and, at most once an hour, prunes expired ones. Never throws; returns whether
 * the row was written so tests can assert on it.
 */
export function recordGuardrailEvent(event: GuardrailEventRecord): boolean {
  try {
    const ts = event.ts ?? Date.now();
    getDbInstance()
      .prepare(
        `INSERT INTO guardrail_events (ts, guardrail_id, stage, action, api_key_id, request_id, rule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts,
        event.guardrailId,
        event.stage,
        event.action,
        event.apiKeyId ?? null,
        event.requestId ?? null,
        event.ruleId ?? null
      );
    const now = Date.now();
    if (now - lastPruneAt >= GUARDRAIL_EVENT_PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      pruneGuardrailEvents(now);
    }
    return true;
  } catch {
    return false;
  }
}

export interface ListGuardrailEventsOptions {
  limit?: number;
  /** Epoch ms; only events at or after this instant. */
  since?: number;
  guardrail?: string;
}

/** Newest first. */
export function listGuardrailEvents(options: ListGuardrailEventsOptions = {}): GuardrailEventRow[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.since !== undefined) {
    where.push("ts >= ?");
    params.push(options.since);
  }
  if (options.guardrail) {
    where.push("guardrail_id = ?");
    params.push(options.guardrail);
  }
  const rows = getDbInstance()
    .prepare(
      `SELECT id, ts, guardrail_id, stage, action, api_key_id, request_id, rule_id
         FROM guardrail_events
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ts DESC, id DESC
        LIMIT ?`
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    ts: Number(row.ts),
    guardrailId: String(row.guardrail_id),
    stage: row.stage as GuardrailEventStage,
    action: row.action as GuardrailEventAction,
    apiKeyId: row.api_key_id === null ? null : String(row.api_key_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    ruleId: row.rule_id === null ? null : String(row.rule_id),
  }));
}

/** Per-guardrail counts by action for events at or after `since` (default: the last 24 h). */
export function countGuardrailEvents(
  since = Date.now() - GUARDRAIL_EVENT_SUMMARY_WINDOW_MS
): GuardrailEventCounts[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT guardrail_id, action, COUNT(*) AS n
         FROM guardrail_events
        WHERE ts >= ?
        GROUP BY guardrail_id, action`
    )
    .all(since) as Array<Record<string, unknown>>;
  const byGuardrail = new Map<string, GuardrailEventCounts>();
  for (const row of rows) {
    const id = String(row.guardrail_id);
    const entry = byGuardrail.get(id) ?? { guardrailId: id, block: 0, flag: 0, mask: 0, total: 0 };
    const action = row.action as GuardrailEventAction;
    const count = Number(row.n);
    if (action === "block" || action === "flag" || action === "mask") entry[action] += count;
    entry.total += count;
    byGuardrail.set(id, entry);
  }
  return [...byGuardrail.values()].sort(
    (a, b) => b.total - a.total || a.guardrailId.localeCompare(b.guardrailId)
  );
}
