/**
 * Budget engine — decides whether a request may proceed under the reusable budgets assigned to
 * its API key (directly or through a key group) and records the spend that follows.
 *
 * Additive to the per-key budget in `domain/costRules`: a request is refused when either the
 * per-key budget or any budget here blocks it. The two never share state.
 *
 * Rules:
 * - Strictest wins: any exceeded `block` budget blocks; otherwise any exceeded `throttle` budget
 *   throttles; otherwise ok. Throttle applies only when EVERY exceeded budget is `throttle`.
 * - Only metered usage counts. A flat-rate provider is neither checked against nor charged to a
 *   budget (same classification as `lib/usage/meteredBudgetPolicy`).
 * - Fail open: an unreadable budget table must never block traffic. Errors are logged (rate
 *   limited) and the request proceeds.
 *
 * @module domain/budgetEngine
 */

import {
  claimSoftAlert,
  effectiveSoftUsd,
  getApplicableBudgets,
  getBudgetWindowTotal,
  getWindowSpent,
  hasBudgetAssignments,
  hasGroupBudgetAssignments,
  incrementWindowSpend,
  invalidateBudgetSnapshot,
  BUDGET_SNAPSHOT_TTL_MS,
  type ApplicableBudget,
  type Budget,
} from "@/lib/db/budgets";
import { getKeyGroupsForApiKey } from "@/lib/db/apiKeyGroups";
import { isFlatRateProvider } from "@/lib/usage/flatRateProviders";
import { logger } from "@/shared/utils/logger";
import { getBudgetWindow } from "./budgetWindow";

const log = logger.child({ module: "budgets" });

export interface BudgetCheckInput {
  keyId: string | null | undefined;
  provider: string | null | undefined;
  /** Reserved for per-model caps (a later slice); not used to decide today. */
  model?: string | null;
}

export interface BudgetCheckResult {
  state: "ok" | "throttle" | "blocked";
  /** Milliseconds to wait before dispatching, present when state is "throttle". */
  delayMs?: number;
  /** Client-facing reason, present when state is "blocked". */
  reason?: string;
  /** Epoch ms the blocking window ends, when it ends (absent for a "total" budget). */
  resetAt?: number;
  /** The budget that decided the outcome. */
  budgetId?: string;
}

export interface BudgetSpendInput {
  keyId: string | null | undefined;
  provider: string | null | undefined;
  /** Metered cost in USD of the completed call. */
  usd: number;
}

const OK: BudgetCheckResult = { state: "ok" };

/** Upper bound on a throttle delay, whatever the budget says. */
export const MAX_THROTTLE_DELAY_MS = 300_000;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface BudgetWindowInfo {
  /** Epoch ms the window began; 0 for a "total" budget. */
  windowStart: number;
  /** Epoch ms the window ends; null for a "total" budget. */
  resetAt: number | null;
}

export function computeBudgetWindow(
  budget: Pick<Budget, "duration" | "resetTime">,
  now = Date.now()
): BudgetWindowInfo {
  if (budget.duration === "total") return { windowStart: 0, resetAt: null };
  const window = getBudgetWindow(budget.duration, budget.resetTime ?? "00:00", now);
  return { windowStart: window.periodStartAt, resetAt: window.nextResetAt };
}

/** Current-window spend of a budget across all its scopes, for list views. */
export function getBudgetUsage(budget: Budget, now = Date.now()) {
  const window = computeBudgetWindow(budget, now);
  return {
    spentUsd: getBudgetWindowTotal(budget.id, window.windowStart),
    windowStart: window.windowStart,
    resetAt: window.resetAt,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const groupMemo = new Map<string, { at: number; groupIds: string[] }>();

/** Drop every cached view of budgets and group membership (tests, and after bulk changes). */
export function resetBudgetEngineCache(): void {
  invalidateBudgetSnapshot();
  groupMemo.clear();
}

function groupsOfKey(keyId: string, now: number): string[] {
  const cached = groupMemo.get(keyId);
  if (cached && now - cached.at < BUDGET_SNAPSHOT_TTL_MS) return cached.groupIds;
  const groupIds = getKeyGroupsForApiKey(keyId).map((group) => group.id);
  groupMemo.set(keyId, { at: now, groupIds });
  return groupIds;
}

/** Budgets that apply to the key. With no assignments at all this issues no query on the hot path. */
function resolveApplicable(keyId: string, now: number): ApplicableBudget[] {
  if (!hasBudgetAssignments(now)) return [];
  const groupIds = hasGroupBudgetAssignments(now) ? groupsOfKey(keyId, now) : [];
  return getApplicableBudgets(keyId, groupIds, now);
}

// ---------------------------------------------------------------------------
// Fail-open logging
// ---------------------------------------------------------------------------

const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

function warnFailOpen(action: string, error: unknown, now: number): void {
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  log.warn({ err: error, action }, "Budget engine unavailable; failing open");
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Whether a request from this key to this provider may proceed under the assigned budgets. */
export function checkBudgets(input: BudgetCheckInput, now = Date.now()): BudgetCheckResult {
  const { keyId, provider } = input;
  if (!keyId || isFlatRateProvider(provider)) return OK;
  try {
    const applicable = resolveApplicable(keyId, now);
    if (applicable.length === 0) return OK;

    let blocker: { entry: ApplicableBudget; spent: number; resetAt: number | null } | null = null;
    let throttler: { entry: ApplicableBudget; delayMs: number } | null = null;

    for (const entry of applicable) {
      const { budget, scopeValue } = entry;
      const window = computeBudgetWindow(budget, now);
      const spent = getWindowSpent(budget.id, scopeValue, window.windowStart);
      if (spent < budget.maxUsd) continue;

      if (budget.onExceed === "block") {
        // The blocker that clears last decides when the caller may retry (null = never resets).
        const later =
          !blocker ||
          (blocker.resetAt !== null &&
            (window.resetAt === null || window.resetAt > blocker.resetAt));
        if (later) blocker = { entry, spent, resetAt: window.resetAt };
      } else if (!throttler || budget.throttleDelayMs > throttler.delayMs) {
        throttler = { entry, delayMs: budget.throttleDelayMs };
      }
    }

    if (blocker) {
      const { budget } = blocker.entry;
      return {
        state: "blocked",
        reason: `Budget "${budget.name}" exceeded (${money(blocker.spent)} of ${money(budget.maxUsd)}, ${budget.duration})`,
        ...(blocker.resetAt !== null ? { resetAt: blocker.resetAt } : {}),
        budgetId: budget.id,
      };
    }
    if (throttler) {
      return {
        state: "throttle",
        delayMs: Math.min(Math.max(0, throttler.delayMs), MAX_THROTTLE_DELAY_MS),
        budgetId: throttler.entry.budget.id,
      };
    }
    return OK;
  } catch (error) {
    warnFailOpen("check", error, now);
    return OK;
  }
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

type BudgetWarningNotifier = (data: Record<string, unknown>) => void;
let warningNotifier: BudgetWarningNotifier | null = null;

/** Replace the soft-alert delivery (tests). Pass null to restore the webhook dispatcher. */
export function setBudgetWarningNotifier(notifier: BudgetWarningNotifier | null): void {
  warningNotifier = notifier;
}

function notifyWarning(data: Record<string, unknown>): void {
  if (warningNotifier) {
    warningNotifier(data);
    return;
  }
  void import("@/lib/webhookDispatcher")
    .then((module) => module.notifyWebhookEvent("budget.warning", data))
    .catch(() => {
      /* webhook delivery is best-effort */
    });
}

/**
 * Add the cost of a completed call to every budget that applies to the key and raise the soft
 * alert, once per window, when a scope crosses its threshold. `usd` must already be the metered
 * share; a flat-rate provider records nothing here either.
 */
export function recordBudgetSpend(input: BudgetSpendInput, now = Date.now()): void {
  const { keyId, provider, usd } = input;
  if (!keyId || !Number.isFinite(usd) || usd <= 0 || isFlatRateProvider(provider)) return;
  try {
    for (const entry of resolveApplicable(keyId, now)) {
      const { budget, scopeType, scopeValue } = entry;
      const window = computeBudgetWindow(budget, now);
      const spent = incrementWindowSpend(budget.id, scopeValue, window.windowStart, usd);
      const softUsd = effectiveSoftUsd(budget);
      if (spent >= softUsd && claimSoftAlert(budget.id, scopeValue, window.windowStart)) {
        notifyWarning({
          budgetId: budget.id,
          budgetName: budget.name,
          scopeType,
          scopeValue,
          spentUsd: spent,
          softUsd,
          maxUsd: budget.maxUsd,
          duration: budget.duration,
          windowStart: new Date(window.windowStart).toISOString(),
          resetAt: window.resetAt === null ? null : new Date(window.resetAt).toISOString(),
        });
      }
    }
  } catch (error) {
    warnFailOpen("record", error, now);
  }
}
