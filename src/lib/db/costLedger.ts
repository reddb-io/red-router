/**
 * db/costLedger.ts — Per-request cost ledger (RIC-741 / M3 D2).
 *
 * The `request_cost_ledger` table stores one row per completed call with the
 * full cost breakdown (provider / model / token counts / unit prices /
 * computed amount), so every request is traceable to a USD figure without
 * re-aggregating usage_history through pricing on every read.
 *
 * KISS: the ledger is a single-writer append-only table. Writes go through
 * {@link recordLedgerEntry} (batched inside the caller where needed); reads are
 * plain SUM/COUNT aggregations over a time window.
 *
 * @module db/costLedger
 */

import { createHash, randomUUID } from "node:crypto";
import { logger } from "@/shared/utils/logger";
import { tenantIdForUsageKey } from "./tenantUsageAttribution";
import { getDbInstance } from "./core";
import { toNumber } from "@/shared/utils/numeric";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostLedgerEntry {
  apiKeyId: string;
  provider: string;
  model: string;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  tokensReasoning?: number;
  unitPriceInput?: number;
  unitPriceOutput?: number;
  amountUsd: number;
  serviceTier?: string;
  success?: boolean;
  timestamp?: string;
  requestId?: string | null;
  /** Client-supplied end-user id (untrusted, at most 128 characters). */
  endUser?: string | null;
  /** JSON array of lowercase tags, as serialized by `lib/usage/attribution`. */
  tags?: string | null;
  sessionId?: string | null;
  /** Captured when the event is queued, so a later key transfer cannot rewrite ownership. */
  tenantId?: string | null;
  budgetRecovery?: {
    keyId: string;
    provider?: string | null;
    model?: string | null;
    usd: number;
    tags?: readonly string[] | null;
    endUser?: string | null;
  };
}

export interface LedgerAggregate {
  amountUsd: number;
  requestCount: number;
}

export interface KeyLedgerUsage {
  totals: {
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
  };
  by_model: Array<{
    model: string;
    provider: string;
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
  }>;
  tokens_today: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonNegative(value: unknown): number {
  return Math.max(0, toNumber(value));
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Insert a single cost-ledger row. Fire-and-forget callers should use
 * {@link recordLedgerEntrySafe} so a ledger failure never crashes the request.
 */
export function recordLedgerEntry(entry: CostLedgerEntry, eventId: string | null = null): void {
  if (!entry?.apiKeyId) return;
  const db = getDbInstance();
  db.prepare(
    `
    INSERT INTO request_cost_ledger (
      api_key_id, provider, model,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      unit_price_input, unit_price_output, amount_usd,
      service_tier, success, timestamp, request_id, end_user, tags, session_id, tenant_id, event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) WHERE event_id IS NOT NULL DO NOTHING
    `
  ).run(
    entry.apiKeyId,
    entry.provider || "unknown",
    entry.model || "unknown",
    toNonNegative(entry.tokensInput),
    toNonNegative(entry.tokensOutput),
    toNonNegative(entry.tokensCacheRead),
    toNonNegative(entry.tokensCacheCreation),
    toNonNegative(entry.tokensReasoning),
    toNonNegative(entry.unitPriceInput),
    toNonNegative(entry.unitPriceOutput),
    toNonNegative(entry.amountUsd),
    entry.serviceTier || "standard",
    entry.success === false ? 0 : 1,
    entry.timestamp || new Date().toISOString(),
    entry.requestId ?? null,
    entry.endUser ?? null,
    entry.tags ?? null,
    entry.sessionId ?? null,
    entry.tenantId === undefined ? tenantIdForUsageKey(entry.apiKeyId) : entry.tenantId,
    eventId
  );
}

/**
 * Best-effort variant for hot-path callers: never throws, so a ledger hiccup
 * can never block an LLM response. Mirrors recordCost's swallow-and-log.
 */
let failedWrites = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const ledgerLog = logger.child({ module: "cost-ledger" });
export function costLedgerEventId(
  entry: Pick<CostLedgerEntry, "apiKeyId" | "provider" | "model" | "requestId">
): string {
  return entry.requestId
    ? createHash("sha256")
        .update(JSON.stringify([entry.apiKeyId, entry.provider, entry.model, entry.requestId]))
        .digest("hex")
    : randomUUID();
}
export function hasCostLedgerEvent(eventId: string): boolean {
  return Boolean(
    getDbInstance()
      .prepare(
        "SELECT 1 FROM request_cost_ledger WHERE event_id = ? UNION ALL SELECT 1 FROM cost_ledger_outbox WHERE event_id = ? LIMIT 1"
      )
      .get(eventId, eventId)
  );
}
let recoverBudget: ((input: NonNullable<CostLedgerEntry["budgetRecovery"]>) => boolean) | null =
  null;
export function setCostLedgerBudgetRecovery(handler: typeof recoverBudget): void {
  recoverBudget = handler;
}

function scheduleLedgerRecovery(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    try {
      flushCostLedgerOutbox();
      if (getCostLedgerHealth().pendingEvents > 0) scheduleLedgerRecovery();
    } catch (error) {
      ledgerLog.error({ err: error }, "Cost ledger recovery unavailable");
      scheduleLedgerRecovery();
    }
  }, 5000);
  retryTimer.unref();
}

/** Durable replay with one event ID; a failed insert never acknowledges or removes the event. */
export function flushCostLedgerOutbox(limit = 25): void {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT event_id, payload FROM cost_ledger_outbox ORDER BY created_at LIMIT ?")
    .all(Math.max(1, Math.min(100, limit))) as Array<{ event_id: string; payload: string }>;
  for (const row of rows) {
    try {
      db.transaction(() => {
        const entry = JSON.parse(row.payload) as CostLedgerEntry;
        const recorded = db
          .prepare("SELECT 1 FROM request_cost_ledger WHERE event_id = ?")
          .get(row.event_id);
        if (
          !recorded &&
          entry.budgetRecovery &&
          (!recoverBudget || !recoverBudget(entry.budgetRecovery))
        )
          throw new Error("Budget cost recovery pending");
        recordLedgerEntry(entry, row.event_id);
        db.prepare("DELETE FROM cost_ledger_outbox WHERE event_id = ?").run(row.event_id);
      })();
    } catch (error) {
      db.prepare("UPDATE cost_ledger_outbox SET attempts = attempts + 1 WHERE event_id = ?").run(
        row.event_id
      );
      ledgerLog.error({ err: error, eventId: row.event_id }, "Cost event retained for recovery");
      break;
    }
  }
}

export function getCostLedgerHealth(apiKeyId?: string) {
  const db = getDbInstance();
  const row = (
    apiKeyId
      ? db
          .prepare("SELECT COUNT(*) AS count FROM cost_ledger_outbox WHERE api_key_id = ?")
          .get(apiKeyId)
      : db.prepare("SELECT COUNT(*) AS count FROM cost_ledger_outbox").get()
  ) as { count: number };
  return {
    pendingEvents: row.count,
    failedWrites,
    status: row.count || failedWrites ? "degraded" : "healthy",
  };
}

export function recordLedgerEntrySafe(entry: CostLedgerEntry): "recorded" | "queued" | "failed" {
  if (!entry?.apiKeyId) return "recorded";
  try {
    const eventId = costLedgerEventId(entry);
    const payload = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
      tenantId: entry.tenantId === undefined ? tenantIdForUsageKey(entry.apiKeyId) : entry.tenantId,
    };
    getDbInstance()
      .prepare(
        "INSERT OR IGNORE INTO cost_ledger_outbox(event_id, api_key_id, payload, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(eventId, entry.apiKeyId, JSON.stringify(payload), payload.timestamp);
    flushCostLedgerOutbox();
    const pending = getCostLedgerHealth(entry.apiKeyId).pendingEvents;
    if (pending) scheduleLedgerRecovery();
    return pending ? "queued" : "recorded";
  } catch (error) {
    failedWrites += 1;
    ledgerLog.error({ err: error }, "Cost accounting event could not be acknowledged");
    scheduleLedgerRecovery();
    return "failed";
  }
}

/**
 * Batch-insert ledger rows inside one transaction (used by flush paths).
 */
export function recordLedgerEntries(entries: CostLedgerEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const db = getDbInstance();
  const stmt = db.prepare(
    `
    INSERT INTO request_cost_ledger (
      api_key_id, provider, model,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      unit_price_input, unit_price_output, amount_usd,
      service_tier, success, timestamp, request_id, end_user, tags, session_id, tenant_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );
  const tx = db.transaction((rows: CostLedgerEntry[]) => {
    for (const entry of rows) {
      if (!entry?.apiKeyId) continue;
      stmt.run(
        entry.apiKeyId,
        entry.provider || "unknown",
        entry.model || "unknown",
        toNonNegative(entry.tokensInput),
        toNonNegative(entry.tokensOutput),
        toNonNegative(entry.tokensCacheRead),
        toNonNegative(entry.tokensCacheCreation),
        toNonNegative(entry.tokensReasoning),
        toNonNegative(entry.unitPriceInput),
        toNonNegative(entry.unitPriceOutput),
        toNonNegative(entry.amountUsd),
        entry.serviceTier || "standard",
        entry.success === false ? 0 : 1,
        entry.timestamp || new Date().toISOString(),
        entry.requestId ?? null,
        entry.endUser ?? null,
        entry.tags ?? null,
        entry.sessionId ?? null,
        tenantIdForUsageKey(entry.apiKeyId)
      );
    }
  });
  tx(entries);
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

function getAggRow(row: unknown): LedgerAggregate {
  const r = asRecord(row);
  return {
    amountUsd: toNumber(r.amount_usd ?? r.totalUsd),
    requestCount: toNumber(r.request_count ?? r.cnt),
  };
}

/**
 * Sum ledger amount (in USD) and count rows for an api key since an ISO
 * timestamp. `whereClause` is trusted internal SQL appended after `WHERE
 * api_key_id = ?` — callers must only pass fixed fragments, never user input.
 */
export function aggregateLedger(
  apiKeyId: string,
  sinceIso: string,
  opts: { successOnly?: boolean } = {}
): LedgerAggregate {
  if (!apiKeyId) return { amountUsd: 0, requestCount: 0 };
  const successClause = opts.successOnly === true ? " AND success = 1" : "";
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(amount_usd), 0) AS amount_usd,
         COUNT(*) AS request_count
       FROM request_cost_ledger
       WHERE api_key_id = ? AND timestamp >= ?${successClause}`
    )
    .get(apiKeyId, sinceIso);
  return getAggRow(row);
}

/** Bounded grouped read for the legacy MCP get_usage contract. Never scans another key. */
export function getKeyLedgerUsage(
  apiKeyId: string,
  sinceIso: string,
  todayIso: string
): KeyLedgerUsage {
  const empty: KeyLedgerUsage = {
    totals: { requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    by_model: [],
    tokens_today: 0,
  };
  if (!apiKeyId) return empty;
  const db = getDbInstance();
  const totals = asRecord(
    db
      .prepare(
        `SELECT COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(tokens_input), 0) AS prompt_tokens,
              COALESCE(SUM(tokens_output), 0) AS completion_tokens,
              COALESCE(SUM(CASE WHEN success = 1 THEN amount_usd ELSE 0 END), 0) AS cost
       FROM request_cost_ledger
       WHERE api_key_id = ? AND timestamp >= ?`
      )
      .get(apiKeyId, sinceIso)
  );
  const byModel = db
    .prepare(
      `SELECT model, provider, COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(tokens_input), 0) AS prompt_tokens,
            COALESCE(SUM(tokens_output), 0) AS completion_tokens,
            COALESCE(SUM(CASE WHEN success = 1 THEN amount_usd ELSE 0 END), 0) AS cost
     FROM request_cost_ledger
     WHERE api_key_id = ? AND timestamp >= ?
     GROUP BY provider, model
     ORDER BY cost DESC, requests DESC
     LIMIT 20`
    )
    .all(apiKeyId, sinceIso) as Record<string, unknown>[];
  const today = asRecord(
    db
      .prepare(
        `SELECT COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens
       FROM request_cost_ledger
       WHERE api_key_id = ? AND timestamp >= ?`
      )
      .get(apiKeyId, todayIso)
  );
  return {
    totals: {
      requests: toNumber(totals.requests),
      errors: toNumber(totals.errors),
      prompt_tokens: toNumber(totals.prompt_tokens),
      completion_tokens: toNumber(totals.completion_tokens),
      cost: toNumber(totals.cost),
    },
    by_model: byModel.map((item) => ({
      model: String(item.model),
      provider: String(item.provider),
      requests: toNumber(item.requests),
      errors: toNumber(item.errors),
      prompt_tokens: toNumber(item.prompt_tokens),
      completion_tokens: toNumber(item.completion_tokens),
      cost: toNumber(item.cost),
    })),
    tokens_today: toNumber(today.tokens),
  };
}

/**
 * Return ledger rows for an api key within a window (descending timestamp).
 * Used by tests and future dashboard surfaces. `limit` is clamped to 500.
 */
export function listLedgerEntries(
  apiKeyId: string,
  opts: { sinceIso?: string; limit?: number } = {}
): CostLedgerEntry[] {
  if (!apiKeyId) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT *
       FROM request_cost_ledger
       WHERE api_key_id = ?
         ${opts.sinceIso ? "AND timestamp >= ?" : ""}
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(apiKeyId, ...(opts.sinceIso ? [opts.sinceIso] : []), limit) as unknown as Array<
    Record<string, unknown>
  >;

  return rows.map((r) => {
    const row = asRecord(r);
    return {
      apiKeyId,
      provider: typeof row.provider === "string" ? row.provider : "",
      model: typeof row.model === "string" ? row.model : "",
      tokensInput: toNumber(row.tokens_input),
      tokensOutput: toNumber(row.tokens_output),
      tokensCacheRead: toNumber(row.tokens_cache_read),
      tokensCacheCreation: toNumber(row.tokens_cache_creation),
      tokensReasoning: toNumber(row.tokens_reasoning),
      unitPriceInput: toNumber(row.unit_price_input),
      unitPriceOutput: toNumber(row.unit_price_output),
      amountUsd: toNumber(row.amount_usd),
      serviceTier: typeof row.service_tier === "string" ? row.service_tier : "standard",
      success: toNumber(row.success) !== 0,
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      requestId: typeof row.request_id === "string" ? row.request_id : null,
    } satisfies CostLedgerEntry;
  });
}

/**
 * Total ledger spend for an api key within the current calendar month (ISO
 * month window). Used by the monthly-amount quota check so the counter does not
 * need its own window bookkeeping — the ledger IS the counter.
 */
export function aggregateLedgerThisMonth(apiKeyId: string, nowIso?: string): LedgerAggregate {
  const now = nowIso ? new Date(nowIso) : new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return aggregateLedger(apiKeyId, monthStart, { successOnly: true });
}
