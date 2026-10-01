import type { BudgetDuration, BudgetOnExceed } from "@/shared/constants/budgets";

/** A budget as `/api/budgets` returns it. */
export interface BudgetRow {
  id: string;
  name: string;
  maxUsd: number;
  softUsd: number | null;
  effectiveSoftUsd: number;
  duration: BudgetDuration;
  resetTime: string | null;
  onExceed: BudgetOnExceed;
  throttleDelayMs: number;
  /** Tokens / requests per minute per assigned scope; null = no limit. */
  tpmLimit: number | null;
  rpmLimit: number | null;
  /** USD caps keyed by "provider/model", "model" or "provider/*". */
  modelMax: Record<string, number>;
  enabled: boolean;
  keyIds: string[];
  groupIds: string[];
  /** Request tags and end users the budget applies to (client-supplied text: escape on render). */
  tags: string[];
  users: string[];
  usage: {
    spentUsd: number;
    reservedUsd?: number;
    windowStart: string | null;
    resetAt: string | null;
  };
}

/** One row of `/api/usage/attribution`: the spend of a tag or an end user. */
export interface AttributionRow {
  key: string;
  amountUsd: number;
  requestCount: number;
}

/** An API key or key group the assignments can point at. */
export interface AssignableRef {
  id: string;
  name: string;
}

/** The share of the limit at which the used meter turns to warning, then danger feedback. */
export const METER_WARNING_RATIO = 0.8;
export const METER_DANGER_RATIO = 1;

export function meterTone(spentUsd: number, maxUsd: number): "neutral" | "warning" | "danger" {
  const ratio = maxUsd > 0 ? spentUsd / maxUsd : 0;
  if (ratio >= METER_DANGER_RATIO) return "danger";
  if (ratio >= METER_WARNING_RATIO) return "warning";
  return "neutral";
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The message of an API error body, whichever shape the route used. */
export function errorText(payload: unknown, fallback: string): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const details = (error as { details?: Array<{ field: string; message: string }> } | undefined)
    ?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => `${detail.field}: ${detail.message}`).join(", ");
  }
  return fallback;
}
