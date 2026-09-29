/**
 * db/budgets.ts — Reusable budgets: definitions, assignments and per-window spend.
 *
 * Tables: budgets, budget_assignments, budget_windows (migration 203).
 *
 * A budget is a spending cap (window + soft threshold + on-exceed behaviour) assigned to any
 * number of API keys and key groups. This module only stores and counts; the decision of
 * whether a request may proceed lives in `domain/budgetEngine`.
 *
 * Hot path: `getApplicableBudgets` reads an in-memory snapshot of every enabled assignment
 * (5 s TTL, dropped on any write made through this module), so a deployment with no budgets
 * costs at most one query per TTL and none per request.
 *
 * @module db/budgets
 */

import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import {
  DEFAULT_SOFT_RATIO,
  type BudgetDuration,
  type BudgetOnExceed,
  type BudgetScopeType,
} from "@/shared/constants/budgets";

export type { BudgetDuration, BudgetOnExceed, BudgetScopeType };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Budget {
  id: string;
  name: string;
  maxUsd: number;
  /** Explicit soft threshold, or null when it is derived (80% of max). */
  softUsd: number | null;
  duration: BudgetDuration;
  /** HH:MM (UTC) the window rolls over; null = 00:00. */
  resetTime: string | null;
  onExceed: BudgetOnExceed;
  throttleDelayMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetInput {
  name: string;
  maxUsd: number;
  softUsd?: number | null;
  duration: BudgetDuration;
  resetTime?: string | null;
  onExceed?: BudgetOnExceed;
  throttleDelayMs?: number;
  enabled?: boolean;
}

export interface BudgetAssignment {
  scopeType: BudgetScopeType;
  scopeValue: string;
}

/** A budget that applies to a request, with the scope whose spend it counts. */
export interface ApplicableBudget {
  budget: Budget;
  scopeType: BudgetScopeType;
  scopeValue: string;
}

export function effectiveSoftUsd(budget: Pick<Budget, "maxUsd" | "softUsd">): number {
  return budget.softUsd ?? budget.maxUsd * DEFAULT_SOFT_RATIO;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowToBudget(row: Row): Budget {
  return {
    id: String(row.id),
    name: String(row.name),
    maxUsd: Number(row.max_usd),
    softUsd: row.soft_usd === null || row.soft_usd === undefined ? null : Number(row.soft_usd),
    duration: row.duration as BudgetDuration,
    resetTime: typeof row.reset_time === "string" ? row.reset_time : null,
    onExceed: row.on_exceed as BudgetOnExceed,
    throttleDelayMs: Number(row.throttle_delay_ms),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Assignment snapshot (5 s TTL)
// ---------------------------------------------------------------------------

/** How long the assignment map is trusted before it is re-read. */
export const BUDGET_SNAPSHOT_TTL_MS = 5_000;

interface Snapshot {
  loadedAt: number;
  byKey: Map<string, ApplicableBudget[]>;
  byGroup: Map<string, ApplicableBudget[]>;
}

let snapshot: Snapshot | null = null;

/** Drop the cached assignment map. Every write in this module calls it. */
export function invalidateBudgetSnapshot(): void {
  snapshot = null;
}

function loadSnapshot(now: number): Snapshot {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT b.*, a.scope_type AS a_scope_type, a.scope_value AS a_scope_value
         FROM budget_assignments a
         JOIN budgets b ON b.id = a.budget_id
        WHERE b.enabled = 1`
    )
    .all() as Row[];
  const next: Snapshot = { loadedAt: now, byKey: new Map(), byGroup: new Map() };
  for (const row of rows) {
    const scopeType = row.a_scope_type as BudgetScopeType;
    const scopeValue = String(row.a_scope_value);
    const target = scopeType === "group" ? next.byGroup : next.byKey;
    const list = target.get(scopeValue) ?? [];
    list.push({ budget: rowToBudget(row), scopeType, scopeValue });
    target.set(scopeValue, list);
  }
  return next;
}

function getSnapshot(now = Date.now()): Snapshot {
  if (snapshot && now - snapshot.loadedAt < BUDGET_SNAPSHOT_TTL_MS) return snapshot;
  snapshot = loadSnapshot(now);
  return snapshot;
}

/** Whether any enabled budget is assigned to a group (so callers know to resolve key groups). */
export function hasGroupBudgetAssignments(now = Date.now()): boolean {
  return getSnapshot(now).byGroup.size > 0;
}

/** Whether any enabled budget is assigned to anything at all. */
export function hasBudgetAssignments(now = Date.now()): boolean {
  const current = getSnapshot(now);
  return current.byKey.size > 0 || current.byGroup.size > 0;
}

/**
 * Enabled budgets that apply to a key: the ones assigned to the key itself plus the ones
 * assigned to any of the key's groups. Served from the snapshot.
 */
export function getApplicableBudgets(
  keyId: string,
  groupIds: readonly string[] = [],
  now = Date.now()
): ApplicableBudget[] {
  const current = getSnapshot(now);
  const found: ApplicableBudget[] = [];
  const direct = current.byKey.get(keyId);
  if (direct) found.push(...direct);
  for (const groupId of groupIds) {
    const viaGroup = current.byGroup.get(groupId);
    if (viaGroup) found.push(...viaGroup);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Budget CRUD
// ---------------------------------------------------------------------------

export function listBudgets(): Budget[] {
  const rows = getDbInstance()
    .prepare("SELECT * FROM budgets ORDER BY name COLLATE NOCASE ASC, created_at ASC")
    .all() as Row[];
  return rows.map(rowToBudget);
}

export function getBudgetById(id: string): Budget | null {
  const row = getDbInstance().prepare("SELECT * FROM budgets WHERE id = ?").get(id) as
    Row | undefined;
  return row ? rowToBudget(row) : null;
}

export function createBudget(input: BudgetInput): Budget {
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO budgets
       (id, name, max_usd, soft_usd, duration, reset_time, on_exceed, throttle_delay_ms,
        enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.maxUsd,
    input.softUsd ?? null,
    input.duration,
    input.resetTime ?? null,
    input.onExceed ?? "block",
    input.throttleDelayMs ?? 1000,
    input.enabled === false ? 0 : 1,
    now,
    now
  );
  invalidateBudgetSnapshot();
  return getBudgetById(id)!;
}

/** Merge a partial change into a budget. Returns null when the budget does not exist. */
export function updateBudget(id: string, patch: Partial<BudgetInput>): Budget | null {
  const existing = getBudgetById(id);
  if (!existing) return null;
  const merged = {
    name: patch.name ?? existing.name,
    maxUsd: patch.maxUsd ?? existing.maxUsd,
    softUsd: patch.softUsd !== undefined ? patch.softUsd : existing.softUsd,
    duration: patch.duration ?? existing.duration,
    resetTime: patch.resetTime !== undefined ? patch.resetTime : existing.resetTime,
    onExceed: patch.onExceed ?? existing.onExceed,
    throttleDelayMs: patch.throttleDelayMs ?? existing.throttleDelayMs,
    enabled: patch.enabled ?? existing.enabled,
  };
  getDbInstance()
    .prepare(
      `UPDATE budgets
          SET name = ?, max_usd = ?, soft_usd = ?, duration = ?, reset_time = ?, on_exceed = ?,
              throttle_delay_ms = ?, enabled = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(
      merged.name,
      merged.maxUsd,
      merged.softUsd,
      merged.duration,
      merged.resetTime,
      merged.onExceed,
      merged.throttleDelayMs,
      merged.enabled ? 1 : 0,
      new Date().toISOString(),
      id
    );
  invalidateBudgetSnapshot();
  return getBudgetById(id);
}

/** Delete a budget with its assignments and spend history. Foreign keys are not enforced. */
export function deleteBudget(id: string): boolean {
  const db = getDbInstance();
  const removed = db.transaction(() => {
    db.prepare("DELETE FROM budget_windows WHERE budget_id = ?").run(id);
    db.prepare("DELETE FROM budget_assignments WHERE budget_id = ?").run(id);
    return db.prepare("DELETE FROM budgets WHERE id = ?").run(id).changes > 0;
  })();
  invalidateBudgetSnapshot();
  return removed;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function getBudgetAssignments(budgetId: string): BudgetAssignment[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT scope_type, scope_value FROM budget_assignments
        WHERE budget_id = ? ORDER BY scope_type ASC, scope_value ASC`
    )
    .all(budgetId) as Row[];
  return rows.map((row) => ({
    scopeType: row.scope_type as BudgetScopeType,
    scopeValue: String(row.scope_value),
  }));
}

/** Assignments of every budget in one query, keyed by budget id (for list views). */
export function getAllBudgetAssignments(): Map<string, BudgetAssignment[]> {
  const rows = getDbInstance()
    .prepare(
      `SELECT budget_id, scope_type, scope_value FROM budget_assignments
        ORDER BY scope_type ASC, scope_value ASC`
    )
    .all() as Row[];
  const byBudget = new Map<string, BudgetAssignment[]>();
  for (const row of rows) {
    const id = String(row.budget_id);
    const list = byBudget.get(id) ?? [];
    list.push({
      scopeType: row.scope_type as BudgetScopeType,
      scopeValue: String(row.scope_value),
    });
    byBudget.set(id, list);
  }
  return byBudget;
}

/** Replace the whole assignment set of a budget. Duplicates in the input are collapsed. */
export function replaceBudgetAssignments(
  budgetId: string,
  assignments: readonly BudgetAssignment[]
): BudgetAssignment[] {
  const db = getDbInstance();
  const now = new Date().toISOString();
  const unique = new Map<string, BudgetAssignment>();
  for (const assignment of assignments) {
    unique.set(`${assignment.scopeType}:${assignment.scopeValue}`, assignment);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM budget_assignments WHERE budget_id = ?").run(budgetId);
    const insert = db.prepare(
      `INSERT INTO budget_assignments (budget_id, scope_type, scope_value, created_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const assignment of unique.values()) {
      insert.run(budgetId, assignment.scopeType, assignment.scopeValue, now);
    }
  })();
  invalidateBudgetSnapshot();
  return getBudgetAssignments(budgetId);
}

// ---------------------------------------------------------------------------
// Window spend
// ---------------------------------------------------------------------------

/**
 * Add `usd` to a budget's spend for one scope and window, as a single atomic UPSERT (never a
 * read-modify-write, so concurrent requests cannot lose an increment). Returns the new total.
 */
export function incrementWindowSpend(
  budgetId: string,
  scopeValue: string,
  windowStart: number,
  usd: number
): number {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO budget_windows (budget_id, scope_value, window_start, spent_usd, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(budget_id, scope_value, window_start) DO UPDATE SET
       spent_usd = spent_usd + excluded.spent_usd,
       updated_at = excluded.updated_at`
  ).run(budgetId, scopeValue, windowStart, usd, new Date().toISOString());
  return getWindowSpent(budgetId, scopeValue, windowStart);
}

export function getWindowSpent(budgetId: string, scopeValue: string, windowStart: number): number {
  const row = getDbInstance()
    .prepare(
      `SELECT spent_usd FROM budget_windows
        WHERE budget_id = ? AND scope_value = ? AND window_start = ?`
    )
    .get(budgetId, scopeValue, windowStart) as Row | undefined;
  return row ? Number(row.spent_usd) : 0;
}

/** Spend of a budget in one window summed over every scope assigned to it. */
export function getBudgetWindowTotal(budgetId: string, windowStart: number): number {
  const row = getDbInstance()
    .prepare(
      `SELECT COALESCE(SUM(spent_usd), 0) AS total FROM budget_windows
        WHERE budget_id = ? AND window_start = ?`
    )
    .get(budgetId, windowStart) as Row | undefined;
  return row ? Number(row.total) : 0;
}

/**
 * Claim the soft-threshold alert for one window. True for exactly one caller per
 * (budget, scope, window), across restarts and processes, because the flag is a conditional
 * UPDATE on the durable row.
 */
export function claimSoftAlert(budgetId: string, scopeValue: string, windowStart: number): boolean {
  const result = getDbInstance()
    .prepare(
      `UPDATE budget_windows SET alerted_at = ?
        WHERE budget_id = ? AND scope_value = ? AND window_start = ? AND alerted_at IS NULL`
    )
    .run(new Date().toISOString(), budgetId, scopeValue, windowStart);
  return result.changes === 1;
}
