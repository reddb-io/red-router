import { randomUUID } from "node:crypto";
import { getDbInstance } from "@/lib/db/core";
import { getPricingForModel } from "@/lib/db/settings/pricing";
import {
  cancelUndispatchedUsageOnDb,
  isAccountedProvider,
  markUsageDispatchedOnDb,
  reserveUsageOnDb,
  settleUsageOnDb,
  type AccountedProvider,
  type ReservedUsagePrices,
} from "@/lib/db/sharedUsageReservation";

export type SharedUsageAttempt = {
  id: string;
  keyId: string;
  provider: AccountedProvider;
  model: string;
  prices: ReservedUsagePrices;
};

export type SharedUsageAdmission =
  | { state: "disabled" }
  | { state: "denied" }
  | { state: "unavailable" }
  | { state: "reserved"; attempt: SharedUsageAttempt };

function finiteNonnegative(value: unknown, name: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

function reservationBounds(): { tokens: number; usd: number } {
  const tokens = finiteNonnegative(
    process.env.RED_ROUTER_PRODUCT_RESERVE_TOKENS,
    "token reservation bound"
  );
  const usd = finiteNonnegative(
    process.env.RED_ROUTER_PRODUCT_RESERVE_USD,
    "spend reservation bound"
  );
  if (!Number.isSafeInteger(tokens)) throw new Error("Invalid token reservation bound");
  return { tokens, usd };
}

function pricingSnapshot(pricing: unknown): ReservedUsagePrices {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw new Error("Pricing unavailable for shared usage reservation");
  }
  const row = pricing as Record<string, unknown>;
  const input = finiteNonnegative(row.input, "input price");
  const output = finiteNonnegative(row.output, "output price");
  return {
    input,
    output,
    cached: finiteNonnegative(row.cached ?? input, "cached input price"),
    cacheCreation: finiteNonnegative(row.cache_creation ?? input, "cache creation price"),
    reasoning: finiteNonnegative(row.reasoning ?? output, "reasoning price"),
  };
}

/**
 * Reserve one actual provider attempt. The row is durably marked dispatched
 * before this function returns, so callers must invoke it immediately before
 * sending and must not cancel it after an uncertain transport outcome.
 */
export async function beginSharedUsageAttempt(
  keyId: string,
  provider: string,
  model: string,
  connectionId?: string | null
): Promise<SharedUsageAdmission> {
  if (
    process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS !== "1" ||
    process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS !== "1"
  ) {
    return { state: "disabled" };
  }
  if (!isAccountedProvider(provider)) return { state: "unavailable" };

  let id: string | null = null;
  let db: ReturnType<typeof getDbInstance> | null = null;
  try {
    const prices = pricingSnapshot(await getPricingForModel(provider, model));
    const bounds = reservationBounds();
    db = getDbInstance();
    id = randomUUID();
    const allowed = reserveUsageOnDb(db, {
      id,
      keyId,
      tokens: bounds.tokens,
      usd: bounds.usd,
      nowMs: Date.now(),
      provider,
      model,
      connectionId,
      prices,
    });
    if (!allowed) return { state: "denied" };
    if (!markUsageDispatchedOnDb(db, id, keyId)) {
      cancelUndispatchedUsageOnDb(db, id, keyId);
      return { state: "unavailable" };
    }
    return { state: "reserved", attempt: { id, keyId, provider, model, prices } };
  } catch {
    if (db && id) {
      try {
        cancelUndispatchedUsageOnDb(db, id, keyId);
      } catch {
        // A failed cleanup remains a visibly reserved, never-dispatched row for reconciliation.
      }
    }
    return { state: "unavailable" };
  }
}

function usageInteger(tokens: Record<string, number>, keys: string[]): number {
  for (const key of keys) {
    if (!(key in tokens)) continue;
    const value = tokens[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid completed usage");
    return value;
  }
  return 0;
}

/** Settle cost, ledger and TPM in the same SQLite transaction. */
export function settleSharedUsageAttempt(
  attempt: SharedUsageAttempt,
  tokens: Record<string, number>,
  attribution?: {
    endUser?: string | null;
    tags?: readonly string[] | null;
    sessionId?: string | null;
  } | null
): void {
  settleUsageOnDb(getDbInstance(), {
    id: attempt.id,
    keyId: attempt.keyId,
    provider: attempt.provider,
    model: attempt.model,
    input: usageInteger(tokens, ["prompt_tokens", "input_tokens"]),
    output: usageInteger(tokens, ["completion_tokens", "output_tokens"]),
    reasoning: usageInteger(tokens, ["reasoning_tokens"]),
    cacheRead: usageInteger(tokens, ["cache_read_input_tokens", "cached_tokens"]),
    cacheCreation: usageInteger(tokens, ["cache_creation_input_tokens"]),
    prices: attempt.prices,
    attribution,
    nowMs: Date.now(),
  });
}
