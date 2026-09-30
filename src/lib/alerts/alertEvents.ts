/**
 * Alert events: provider circuit transitions, terminal connection states and low quota,
 * delivered through the existing webhook dispatcher (`notifyWebhookEvent`).
 *
 * Every hook in the request path is a one-line call into this module. Emission is
 * fire-and-forget and can never throw into the caller: each entry point is wrapped, the
 * dispatcher is loaded lazily, and delivery errors are swallowed (the dispatcher records
 * them in the delivery log).
 *
 * Payloads are deliberately narrow: provider id, opaque connection id, state, a short
 * reason code and a timestamp. They never carry API keys, tokens, e-mails, account or
 * connection names, or free-text error messages.
 *
 * This file must stay free of static `@/` imports: `circuitBreaker.ts` imports it through a
 * relative path and is also loaded outside the Next.js alias resolver.
 */

import type { WebhookEvent } from "../webhooks/eventDescriptions";

/** A flapping breaker emits at most one event per provider per state per this window. */
export const ALERT_DEDUP_WINDOW_MS = 5 * 60_000;
/** A quota window alerts when at or below this remaining percentage... */
export const QUOTA_LOW_THRESHOLD_PCT = 10;
/** ...and re-arms only after it has recovered above this one (hysteresis). */
export const QUOTA_LOW_REARM_PCT = 15;

const MAX_TRACKED_KEYS = 2_000;
/** Connection statuses that never recover by themselves (AGENTS.md, Connection Cooldown). */
const TERMINAL_CONNECTION_STATES = new Set(["banned", "expired", "credits_exhausted"]);

type AlertEmitter = (event: WebhookEvent, data: Record<string, unknown>) => void;

let emitter: AlertEmitter | null = null;
const lastEmittedAt = new Map<string, number>();
/** Quota windows currently in the "low" state, so a steady low reading alerts once. */
const lowQuotaWindows = new Set<string>();

function defaultEmit(event: WebhookEvent, data: Record<string, unknown>): void {
  import("../webhookDispatcher")
    .then((module) => module.notifyWebhookEvent(event, data))
    .catch(() => {
      /* alert delivery is best-effort */
    });
}

function emit(event: WebhookEvent, data: Record<string, unknown>): void {
  try {
    (emitter ?? defaultEmit)(event, data);
  } catch {
    /* an alert must never break the request path */
  }
}

/** True when `key` has not emitted within the dedup window; records the emission. */
function claim(key: string, now: number): boolean {
  const last = lastEmittedAt.get(key);
  if (last !== undefined && now - last < ALERT_DEDUP_WINDOW_MS) return false;
  if (lastEmittedAt.size >= MAX_TRACKED_KEYS) {
    for (const [trackedKey, at] of lastEmittedAt) {
      if (now - at >= ALERT_DEDUP_WINDOW_MS) lastEmittedAt.delete(trackedKey);
    }
    if (lastEmittedAt.size >= MAX_TRACKED_KEYS) lastEmittedAt.clear();
  }
  lastEmittedAt.set(key, now);
  return true;
}

/** Reduce a free-form reason to a short machine code (`probe-failed (cycle 3)` -> `probe-failed`). */
export function toReasonCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.split(/[\s(]/, 1)[0]?.toLowerCase() ?? "";
  const code = head.replace(/[^a-z0-9_:.-]/g, "").slice(0, 48);
  return code.length > 0 ? code : null;
}

/**
 * Provider circuit breaker transition. Connection-scoped breakers (`provider::conn::id`)
 * are ignored: this alerts on whole-provider health only.
 */
export function notifyCircuitTransition(
  name: string,
  from: string,
  to: string,
  reason?: string | null,
  now: number = Date.now()
): void {
  try {
    if (!name || name.includes("::") || from === to) return;
    let event: WebhookEvent;
    if (to === "OPEN") {
      event = "provider.circuit_open";
    } else if (to === "CLOSED" && (from === "OPEN" || from === "HALF_OPEN")) {
      event = "provider.circuit_closed";
    } else {
      return;
    }
    if (!claim(`${event}:${name}`, now)) return;
    emit(event, {
      provider: name,
      state: to,
      previousState: from,
      reason: toReasonCode(reason),
      at: new Date(now).toISOString(),
    });
  } catch {
    /* never throw into the breaker */
  }
}

interface ConnectionLike {
  id?: unknown;
  provider?: unknown;
  testStatus?: unknown;
  errorCode?: unknown;
  lastErrorType?: unknown;
}

function normalizeState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * A connection row was rewritten. Emits `connection.unavailable` only when its status just
 * changed INTO a terminal state (banned / expired / credits_exhausted).
 */
export function notifyConnectionStatusChange(
  before: ConnectionLike | null | undefined,
  after: ConnectionLike | null | undefined,
  now: number = Date.now()
): void {
  try {
    if (!before || !after) return;
    const next = normalizeState(after.testStatus);
    const previous = normalizeState(before.testStatus);
    if (!TERMINAL_CONNECTION_STATES.has(next) || next === previous) return;
    const connectionId = typeof after.id === "string" ? after.id : String(before.id ?? "");
    if (!connectionId) return;
    if (!claim(`connection.unavailable:${connectionId}:${next}`, now)) return;
    emit("connection.unavailable", {
      provider: typeof after.provider === "string" ? after.provider : null,
      connectionId,
      state: next,
      previousState: previous || "unknown",
      reason: toReasonCode(after.lastErrorType),
      errorCode: typeof after.errorCode === "number" ? after.errorCode : null,
      at: new Date(now).toISOString(),
    });
  } catch {
    /* never throw into the connection write path */
  }
}

interface QuotaSnapshotLike {
  provider?: unknown;
  connection_id?: unknown;
  window_key?: unknown;
  remaining_percentage?: unknown;
  is_exhausted?: unknown;
  next_reset_at?: unknown;
}

/**
 * A quota snapshot was recorded. Emits `quota.low` once when a window crosses to the low
 * band and again only after it recovered above the re-arm level.
 */
export function notifyQuotaSnapshot(
  snapshot: QuotaSnapshotLike | null | undefined,
  now: number = Date.now()
): void {
  try {
    if (!snapshot) return;
    const remaining = Number(snapshot.remaining_percentage);
    if (!Number.isFinite(remaining)) return;
    const windowKey = `${String(snapshot.provider)}:${String(snapshot.connection_id)}:${String(snapshot.window_key)}`;
    const exhausted = Number(snapshot.is_exhausted) === 1 || snapshot.is_exhausted === true;

    if (remaining > QUOTA_LOW_REARM_PCT) {
      lowQuotaWindows.delete(windowKey);
      return;
    }
    if (remaining > QUOTA_LOW_THRESHOLD_PCT && !exhausted) return;
    if (lowQuotaWindows.has(windowKey)) return;
    if (lowQuotaWindows.size >= MAX_TRACKED_KEYS) lowQuotaWindows.clear();
    lowQuotaWindows.add(windowKey);

    emit("quota.low", {
      provider: typeof snapshot.provider === "string" ? snapshot.provider : null,
      connectionId: typeof snapshot.connection_id === "string" ? snapshot.connection_id : null,
      window: typeof snapshot.window_key === "string" ? snapshot.window_key : null,
      remainingPercentage: remaining,
      exhausted,
      nextResetAt: typeof snapshot.next_reset_at === "string" ? snapshot.next_reset_at : null,
      at: new Date(now).toISOString(),
    });
  } catch {
    /* never throw into the snapshot write path */
  }
}

/** Test seam: capture emissions instead of reaching the webhook dispatcher. */
export function __setAlertEmitterForTest(fn: AlertEmitter | null): void {
  emitter = fn;
}

/** Test seam: forget every dedup and low-quota record. */
export function __resetAlertStateForTest(): void {
  lastEmittedAt.clear();
  lowQuotaWindows.clear();
}
