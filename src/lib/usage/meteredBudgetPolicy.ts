/**
 * Metered-budget policy — provider economics applied to the dollar budget.
 *
 * The dollar budget in {@link module:domain/costRules} is scoped by apiKeyId
 * alone and has no scope dimension for the provider that will actually serve
 * the request. Enforced at the api-key policy phase — before provider
 * resolution — it can only answer "has this key spent its allowance?", never
 * "would this request spend any of it?". Once the allowance is gone, a
 * flat-rate subscription that costs nothing per call is rejected together with
 * the metered APIs, because the gate cannot tell them apart.
 *
 * This module supplies the missing dimension. It reads the ONE existing
 * economic classification ({@link isFlatRateProvider}) and derives both halves
 * of the metered-budget decision from it, so eligibility and accounting can
 * never drift apart:
 *
 * - {@link consumesMeteredBudget} — does a call to this provider spend the
 *   metered allowance at all?
 * - {@link meteredBudgetCost} — how much of the allowance does a completed
 *   call consume?
 * - {@link checkMeteredBudgetForProvider} — may this candidate be served
 *   under the key's current budget state?
 *
 * Fail-closed by construction: the classification recognises flat-rate plans
 * explicitly, so an unknown or unclassified provider is metered and stays
 * subject to the allowance. A provider never becomes free by being unknown.
 *
 * Cost OBSERVABILITY is deliberately untouched. Analytics compute their own
 * per-row cost from the request log with the `flatRateAsZero` option
 * (`lib/usage/costCalculator`, `lib/usage/usageStats`), so exempting flat-rate
 * traffic from budget CONSUMPTION here removes nothing from the dashboards.
 *
 * @module lib/usage/meteredBudgetPolicy
 */

import { checkBudget } from "@/domain/costRules";
import {
  checkBudgets,
  getBudgetReservationScopes,
  MAX_THROTTLE_DELAY_MS,
  recordBudgetAdmission,
} from "@/domain/budgetEngine";
import { isFlatRateProvider } from "./flatRateProviders";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { flushCostLedgerOutbox, getCostLedgerHealth } from "@/lib/db/costLedger";
import {
  getReservedKeyCost,
  reserveBudgetCost,
  withBudgetAdmissionTransaction,
} from "@/lib/db/budgetReservations";

/**
 * Whether a call to this provider draws down the metered dollar allowance.
 *
 * Flat-rate plans are paid for by a subscription the allowance does not
 * govern; everything else — including an unknown provider — is metered.
 */
export function consumesMeteredBudget(providerId: string | null | undefined): boolean {
  return !isFlatRateProvider(providerId);
}

/**
 * The portion of an estimated request cost that the metered allowance should
 * absorb. Flat-rate providers contribute nothing: their per-token rows exist
 * for estimates and analytics, not for a bill the allowance is tracking.
 *
 * A negative or non-finite estimate is clamped to 0 so a bad pricing lookup
 * can never credit the allowance back.
 */
export function meteredBudgetCost(
  providerId: string | null | undefined,
  estimatedCost: number
): number {
  if (!consumesMeteredBudget(providerId)) return 0;
  if (!Number.isFinite(estimatedCost) || estimatedCost <= 0) return 0;
  return estimatedCost;
}

/**
 * Who is asking: a bare key id, or the request's key record when it carries the attribution the
 * chat handler resolved (`lib/usage/attribution`).
 */
export type BudgetActor =
  | string
  | {
      id?: string | null;
      attribution?: { tags?: readonly string[] | null; endUser?: string | null } | null;
    }
  | null
  | undefined;

function splitActor(actor: BudgetActor) {
  if (typeof actor === "string") return { keyId: actor, tags: undefined, endUser: undefined };
  return {
    keyId: actor?.id,
    tags: actor?.attribution?.tags,
    endUser: actor?.attribution?.endUser,
  };
}

export interface MeteredBudgetDecision {
  /** May this candidate be served under the key's current budget state? */
  allowed: boolean;
  /** Client-facing reason, present only when `allowed` is false. */
  reason?: string;
  /** Epoch ms the exhausted window ends, when known (drives Retry-After). */
  retryAfter?: number;
  /** Throttle: the candidate is allowed, but only after waiting this many ms. */
  delayMs?: number;
  code?: "BUDGET_UNAVAILABLE";
}

const ALLOWED: MeteredBudgetDecision = { allowed: true };

/**
 * Budget eligibility for ONE candidate provider.
 *
 * This is an eligibility answer, never a routing answer: it can remove a
 * candidate from consideration, and it can never nominate one. Ranking,
 * health, quota and compatibility stay where they are — the router remains the
 * single authority over which eligible candidate is used.
 *
 * A key with no budget configured, or with budget remaining, is allowed for
 * every provider. A key whose allowance is spent is allowed only for providers
 * that do not consume it.
 *
 * Two independent budgets are consulted and either can refuse: the per-key
 * budget (`domain/costRules`) and the reusable budgets assigned to the key,
 * its groups, the request's tags or its end user (`domain/budgetEngine`). The
 * latter can also answer "throttle" (allowed, after a delay).
 */
export function checkMeteredBudgetForProvider(
  actor: BudgetActor,
  providerId: string | null | undefined,
  model?: string | null,
  additionalUsd = 0
): MeteredBudgetDecision {
  const { keyId: apiKeyId, tags, endUser } = splitActor(actor);
  if (!apiKeyId) return ALLOWED;
  try {
    flushCostLedgerOutbox();
    if (getCostLedgerHealth(apiKeyId).pendingEvents > 0) {
      return {
        allowed: false,
        code: "BUDGET_UNAVAILABLE",
        reason: "Cost accounting recovery pending",
      };
    }
  } catch {
    return { allowed: false, code: "BUDGET_UNAVAILABLE", reason: "Cost accounting unavailable" };
  }
  if (consumesMeteredBudget(providerId)) {
    try {
      const existing = checkBudget(apiKeyId);
      const budget = checkBudget(
        apiKeyId,
        additionalUsd + getReservedKeyCost(apiKeyId, existing.periodStartAt ?? 0)
      );
      if (!budget.allowed) {
        return {
          allowed: false,
          reason: budget.reason || "Budget limit exceeded",
          ...(budget.budgetResetAt ? { retryAfter: budget.budgetResetAt } : {}),
        };
      }
    } catch {
      return { allowed: false, code: "BUDGET_UNAVAILABLE", reason: "Budget policy unavailable" };
    }
  }
  const engine = checkBudgets({
    keyId: apiKeyId,
    provider: providerId,
    model,
    tags,
    endUser,
    additionalUsd,
  });
  if (engine.state === "blocked") {
    return {
      allowed: false,
      reason: engine.reason || "Budget limit exceeded",
      ...(engine.code ? { code: engine.code } : {}),
      ...(engine.resetAt ? { retryAfter: engine.resetAt } : {}),
    };
  }
  if (engine.state === "throttle") return { allowed: true, delayMs: engine.delayMs };
  return ALLOWED;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The per-dispatch monetary-eligibility gate: called once a candidate provider
 * is known, before a credential is acquired (a refusal must never take one), and
 * before the fallback loop (a local refusal must never be read as an upstream
 * rate limit and cool a healthy connection). Returns the 429 to send, or null to
 * proceed. Kept out of the handler to stay under its frozen file-size ratchet.
 */
export async function rejectIfMeteredBudgetExceeded(
  actor: BudgetActor,
  providerId: string | null | undefined,
  modelStr: string,
  reservation?: { id: string; usd: number }
): Promise<Response | null> {
  let decision = checkMeteredBudgetForProvider(actor, providerId, modelStr, reservation?.usd);
  if (decision.allowed && decision.delayMs && decision.delayMs > 0) {
    const waitMs = Math.min(decision.delayMs, MAX_THROTTLE_DELAY_MS);
    log.info("BUDGET", `Throttling ${modelStr} by ${waitMs}ms — a budget on this key is spent`);
    await sleep(waitMs);
  }
  if (decision.allowed) {
    try {
      decision = withBudgetAdmissionTransaction(() => {
        const latest = checkMeteredBudgetForProvider(actor, providerId, modelStr, reservation?.usd);
        if (!latest.allowed) return latest;
        const { keyId, tags, endUser } = splitActor(actor);
        if (reservation && keyId)
          reserveBudgetCost(
            reservation.id,
            keyId,
            reservation.usd,
            getBudgetReservationScopes({
              keyId,
              provider: providerId,
              model: modelStr,
              tags,
              endUser,
            })
          );
        recordBudgetAdmission({ keyId, provider: providerId, tags, endUser });
        return latest;
      });
      if (decision.allowed) return null;
    } catch {
      decision = {
        allowed: false,
        code: "BUDGET_UNAVAILABLE",
        reason: "Budget admission unavailable",
      };
    }
  }
  log.info(
    "BUDGET",
    `Rejecting ${modelStr} — ${providerId} draws on the metered budget and it is exhausted`
  );
  return errorResponse(
    decision.code ? 503 : HTTP_STATUS.RATE_LIMITED,
    decision.reason || "Budget limit exceeded",
    {
      code: decision.code || "BUDGET_EXCEEDED",
      retryAfter: decision.retryAfter,
    }
  );
}
