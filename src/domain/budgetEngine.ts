/**
 * Budget engine — decides whether a request may proceed under the reusable budgets assigned to
 * its API key (directly or through a key group) and records the spend that follows.
 *
 * Additive to the per-key budget in `domain/costRules`: a request is refused when either the
 * per-key budget or any budget here blocks it. The two never share state.
 *
 * A budget applies to a request through its key, the key's groups, the request's tags or its end
 * user (`lib/usage/attribution`). Per (budget, scope) it can limit: total USD per window, USD per
 * model (`provider/model`, bare `model` or `provider/*` keys), tokens per minute and requests per
 * minute (the key quota's 2-bucket sliding-window counters).
 *
 * Rules:
 * - Strictest wins: any exceeded `block` budget blocks; otherwise any exceeded `throttle` budget
 *   throttles; otherwise ok. Throttle applies only when EVERY exceeded budget is `throttle`. A
 *   throttled USD limit waits the budget's delay; a throttled rate limit waits until the minute
 *   bucket rolls over. Both are bounded by {@link MAX_THROTTLE_DELAY_MS}.
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
  getBudgetRateUsed,
  getBudgetSnapshotEpoch,
  getBudgetWindowTotal,
  getModelSpent,
  getWindowSpent,
  hasBudgetAssignments,
  hasGroupBudgetAssignments,
  incrementBudgetRate,
  incrementModelSpend,
  incrementWindowSpend,
  invalidateBudgetSnapshot,
  peekApplicableBudgets,
  BUDGET_SNAPSHOT_TTL_MS,
  type ApplicableBudget,
  type Budget,
  type BudgetScopeExtras,
} from "@/lib/db/budgets";
import { getKeyGroupsForApiKey } from "@/lib/db/apiKeyGroups";
import { isFlatRateProvider } from "@/lib/usage/flatRateProviders";
import { getRequestBudgetScope } from "@/lib/usage/attribution";
import { BUDGET_RATE_WINDOW_MS } from "@/shared/constants/budgets";
import { logger } from "@/shared/utils/logger";
import { getBudgetWindow } from "./budgetWindow";

const log = logger.child({ module: "budgets" });

export interface BudgetCheckInput extends BudgetScopeExtras {
  keyId: string | null | undefined;
  provider: string | null | undefined;
  /** The model the request targets (`provider/model` or a bare model id); matches model caps. */
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

export interface BudgetSpendInput extends BudgetScopeExtras {
  keyId: string | null | undefined;
  provider: string | null | undefined;
  /** The model that served the call; feeds the per-model caps. */
  model?: string | null;
  /** Metered cost in USD of the completed call. */
  usd: number;
}

export interface BudgetTokensInput extends BudgetScopeExtras {
  keyId: string | null | undefined;
  provider: string | null | undefined;
  /** Billable tokens (input + output) of the completed call. */
  tokens: number;
}

export type BudgetAdmissionInput = Pick<
  BudgetCheckInput,
  "keyId" | "provider" | "tags" | "endUser"
>;

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
  exhausted.clear();
}

function groupsOfKey(keyId: string, now: number): string[] {
  const cached = groupMemo.get(keyId);
  if (cached && now - cached.at < BUDGET_SNAPSHOT_TTL_MS) return cached.groupIds;
  const groupIds = getKeyGroupsForApiKey(keyId).map((group) => group.id);
  groupMemo.set(keyId, { at: now, groupIds });
  return groupIds;
}

/** Budgets that apply to the request. With no assignments at all this issues no query on the hot path. */
function resolveApplicable(
  keyId: string,
  now: number,
  extras?: BudgetScopeExtras
): ApplicableBudget[] {
  if (!hasBudgetAssignments(now)) return [];
  const groupIds = hasGroupBudgetAssignments(now) ? groupsOfKey(keyId, now) : [];
  return getApplicableBudgets(keyId, groupIds, now, extras);
}

// ---------------------------------------------------------------------------
// Exhausted scopes (for the combo gate)
// ---------------------------------------------------------------------------

// Which (budget, scope, limit) a blocking check or a recorded spend found spent, until when.
// Kept in memory so routing can skip a target without a database read; a cold map means "not
// known to be exhausted". Dropped whenever a budget or assignment is written.
const exhausted = new Map<string, number>();
const EXHAUSTED_MAX_ENTRIES = 10_000;
let exhaustedEpoch = -1;

function syncExhausted(): void {
  const epoch = getBudgetSnapshotEpoch();
  if (epoch !== exhaustedEpoch) {
    exhausted.clear();
    exhaustedEpoch = epoch;
  }
}

function exhaustedKey(entry: ApplicableBudget, part: string): string {
  return `${entry.budget.id}\u0000${entry.windowScope}\u0000${part}`;
}

function markExhausted(entry: ApplicableBudget, part: string, resetAt: number | null): void {
  if (exhausted.size >= EXHAUSTED_MAX_ENTRIES) exhausted.clear();
  exhausted.set(exhaustedKey(entry, part), resetAt ?? Number.POSITIVE_INFINITY);
}

function isMarkedExhausted(entry: ApplicableBudget, part: string, now: number): boolean {
  const key = exhaustedKey(entry, part);
  const until = exhausted.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  exhausted.delete(key);
  return false;
}

// ---------------------------------------------------------------------------
// Model caps
// ---------------------------------------------------------------------------

/**
 * The keys a call to `provider`'s `model` can be capped under: `provider/model`, the bare model
 * id and the `provider/*` wildcard. `model` may carry a routing prefix (the provider id or an
 * alias of it), which is dropped to reach the bare id.
 */
export function budgetModelCandidates(
  provider: string | null | undefined,
  model: string | null | undefined
): string[] {
  const p = (provider ?? "").trim().toLowerCase();
  const full = (model ?? "").trim().toLowerCase();
  const ids = new Set<string>();
  if (full) ids.add(full.startsWith(`${p}/`) && p ? full.slice(p.length + 1) : full);
  const slash = full.indexOf("/");
  if (slash > 0) ids.add(full.slice(slash + 1));
  const candidates: string[] = [];
  for (const id of ids) {
    if (id === "") continue;
    if (p) candidates.push(`${p}/${id}`);
    candidates.push(id);
  }
  if (p) candidates.push(`${p}/*`);
  return candidates;
}

/** The keys of a budget's model caps that the candidates match (case-insensitive). */
function matchingCapKeys(budget: Budget, candidates: readonly string[]): string[] {
  const keys = Object.keys(budget.modelMax);
  if (keys.length === 0 || candidates.length === 0) return [];
  return keys.filter((key) => candidates.includes(key.toLowerCase()));
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

/** One limit of one (budget, scope) that is spent. */
interface Violation {
  /** Which limit: "usd", "m:<cap key>", "tpm" or "rpm". */
  part: string;
  message: string;
  /** When the limit clears; null = never (a "total" budget). */
  resetAt: number | null;
  /** How long a throttle budget waits before dispatching. */
  delayMs: number;
}

function nextRateBucketAt(now: number): number {
  return (Math.floor(now / BUDGET_RATE_WINDOW_MS) + 1) * BUDGET_RATE_WINDOW_MS;
}

function violationsOf(
  entry: ApplicableBudget,
  candidates: readonly string[],
  now: number
): Violation[] {
  const { budget, windowScope } = entry;
  const found: Violation[] = [];
  const window = computeBudgetWindow(budget, now);
  const spent = getWindowSpent(budget.id, windowScope, window.windowStart);
  if (spent >= budget.maxUsd) {
    found.push({
      part: "usd",
      message: `Budget "${budget.name}" exceeded (${money(spent)} of ${money(budget.maxUsd)}, ${budget.duration})`,
      resetAt: window.resetAt,
      delayMs: budget.throttleDelayMs,
    });
  }
  for (const capKey of matchingCapKeys(budget, candidates)) {
    const cap = budget.modelMax[capKey];
    const used = getModelSpent(budget.id, windowScope, window.windowStart, capKey);
    if (used < cap) continue;
    found.push({
      part: `m:${capKey}`,
      message: `Budget "${budget.name}" cap for ${capKey} exceeded (${money(used)} of ${money(cap)}, ${budget.duration})`,
      resetAt: window.resetAt,
      delayMs: budget.throttleDelayMs,
    });
  }
  const rateResetAt = nextRateBucketAt(now);
  for (const [dimension, limit, unit] of [
    ["tpm", budget.tpmLimit, "tokens"],
    ["rpm", budget.rpmLimit, "requests"],
  ] as const) {
    if (limit === null) continue;
    const used = getBudgetRateUsed(budget.id, windowScope, dimension, now);
    if (used < limit) continue;
    found.push({
      part: dimension,
      message: `Budget "${budget.name}" rate limit reached (${Math.floor(used)} of ${limit} ${unit} per minute)`,
      resetAt: rateResetAt,
      delayMs: rateResetAt - now,
    });
  }
  return found;
}

/** Whether a request from this key to this provider may proceed under the assigned budgets. */
export function checkBudgets(input: BudgetCheckInput, now = Date.now()): BudgetCheckResult {
  const { keyId, provider } = input;
  if (!keyId || isFlatRateProvider(provider)) return OK;
  try {
    syncExhausted();
    const applicable = resolveApplicable(keyId, now, input);
    if (applicable.length === 0) return OK;
    const candidates = budgetModelCandidates(provider, input.model);

    let blocker: { entry: ApplicableBudget; violation: Violation } | null = null;
    let throttler: { entry: ApplicableBudget; delayMs: number } | null = null;

    for (const entry of applicable) {
      for (const violation of violationsOf(entry, candidates, now)) {
        if (entry.budget.onExceed === "block") {
          markExhausted(entry, violation.part, violation.resetAt);
          // The blocker that clears last decides when the caller may retry (null = never resets).
          const later =
            !blocker ||
            (blocker.violation.resetAt !== null &&
              (violation.resetAt === null || violation.resetAt > blocker.violation.resetAt));
          if (later) blocker = { entry, violation };
        } else if (!throttler || violation.delayMs > throttler.delayMs) {
          throttler = { entry, delayMs: violation.delayMs };
        }
      }
    }

    if (blocker) {
      const { violation } = blocker;
      return {
        state: "blocked",
        reason: violation.message,
        ...(violation.resetAt !== null ? { resetAt: violation.resetAt } : {}),
        budgetId: blocker.entry.budget.id,
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

/**
 * Count one admitted request against the requests-per-minute limit of every budget that applies.
 * Called once a candidate passed {@link checkBudgets}, right before it is dispatched.
 */
export function recordBudgetAdmission(input: BudgetAdmissionInput, now = Date.now()): void {
  const { keyId, provider } = input;
  if (!keyId || isFlatRateProvider(provider)) return;
  try {
    for (const entry of resolveApplicable(keyId, now, input)) {
      if (entry.budget.rpmLimit !== null) {
        incrementBudgetRate(entry.budget.id, entry.windowScope, "rpm", 1, now);
      }
    }
  } catch (error) {
    warnFailOpen("admission", error, now);
  }
}

/**
 * Count the billable tokens of a completed call against the tokens-per-minute limit of every
 * budget that applies. Tokens are only known after the call, so the limit trips on the request
 * after the one that crossed it.
 */
export function recordBudgetTokens(input: BudgetTokensInput, now = Date.now()): void {
  const { keyId, provider, tokens } = input;
  if (!keyId || !(tokens > 0) || isFlatRateProvider(provider)) return;
  try {
    for (const entry of resolveApplicable(keyId, now, input)) {
      if (entry.budget.tpmLimit !== null) {
        incrementBudgetRate(entry.budget.id, entry.windowScope, "tpm", tokens, now);
      }
    }
  } catch (error) {
    warnFailOpen("tokens", error, now);
  }
}

/** {@link recordBudgetTokens} for a request's key record (the attribution rides on it). */
export function recordBudgetTokensFor(
  apiKeyInfo:
    | {
        id?: string | null;
        attribution?: { tags?: readonly string[] | null; endUser?: string | null } | null;
      }
    | null
    | undefined,
  provider: string | null | undefined,
  tokens: number
): void {
  recordBudgetTokens({
    keyId: apiKeyInfo?.id,
    provider,
    tokens,
    tags: apiKeyInfo?.attribution?.tags,
    endUser: apiKeyInfo?.attribution?.endUser,
  });
}

/**
 * Whether a routing target is already known to be over a blocking budget, so a combo can pass it
 * over without dispatching. Reads only what is in memory (the assignment snapshot, the group
 * memo and the exhausted map): a cold cache, a request without a registered key or an unknown
 * target all answer false. `signal` is the request's lifecycle signal, the key the handler
 * registered the request under. It is a routing shortcut only: the per-dispatch check stays the
 * authority.
 */
export function isBudgetExhaustedForTarget(
  signal: object | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
  now = Date.now()
): boolean {
  syncExhausted();
  if (exhausted.size === 0 || isFlatRateProvider(provider)) return false;
  const scope = getRequestBudgetScope(signal);
  if (!scope) return false;
  const groupIds = groupMemo.get(scope.keyId)?.groupIds ?? [];
  const candidates = budgetModelCandidates(provider, model);
  for (const entry of peekApplicableBudgets(scope.keyId, groupIds, scope.attribution)) {
    if (entry.budget.onExceed !== "block") continue;
    if (isMarkedExhausted(entry, "usd", now)) return true;
    if (isMarkedExhausted(entry, "tpm", now) || isMarkedExhausted(entry, "rpm", now)) return true;
    for (const capKey of matchingCapKeys(entry.budget, candidates)) {
      if (isMarkedExhausted(entry, `m:${capKey}`, now)) return true;
    }
  }
  return false;
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
    syncExhausted();
    const candidates = budgetModelCandidates(provider, input.model);
    for (const entry of resolveApplicable(keyId, now, input)) {
      const { budget, scopeType, scopeValue, windowScope } = entry;
      const window = computeBudgetWindow(budget, now);
      const spent = incrementWindowSpend(budget.id, windowScope, window.windowStart, usd);
      if (spent >= budget.maxUsd && budget.onExceed === "block") {
        markExhausted(entry, "usd", window.resetAt);
      }
      for (const capKey of matchingCapKeys(budget, candidates)) {
        const used = incrementModelSpend(budget.id, windowScope, window.windowStart, capKey, usd);
        if (used >= budget.modelMax[capKey] && budget.onExceed === "block") {
          markExhausted(entry, `m:${capKey}`, window.resetAt);
        }
      }
      const softUsd = effectiveSoftUsd(budget);
      if (spent >= softUsd && claimSoftAlert(budget.id, windowScope, window.windowStart)) {
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
