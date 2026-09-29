/**
 * RedRouter costed-usage delivery: atomic outbox and at-least-once send.
 *
 * This module owns the billing contract, whatever the transport: deterministic delivery ids,
 * the transactional cursor + outbox commit, the frozen window high-water mark, the lease that
 * lets only one worker send a delivery, and the retry schedule. A transport (`./transports/`)
 * only puts one payload on the wire and reports whether a failure is worth retrying.
 */
import { createHash, randomUUID } from "node:crypto";
import { decryptSecretFields } from "@/lib/logExport/secrets";
import {
  claimUsageDelivery,
  commitUsageBatch,
  finishUsageDelivery,
  getOrStartUsageWindow,
  getUsageDelivery,
  getUsageSink,
  listCostedUsageAfter,
  listDueUsageDeliveries,
  listUsageSinks,
  requeueUsageDelivery,
  setNextUsageWindow,
  type UsageDelivery,
  type UsageSink,
} from "@/lib/db/usageSinks";
import { eventPayload, samplePayload, windowPayload } from "./payloads";
import { getTransport } from "./transports";
import { blankResult, permanentFailure } from "./transports/http";
import type { DeliveryResult, TransportDeps } from "./transports/types";

export { signUsageWebhook } from "./transports/webhook";

const PAGE_SIZE = 500;
const LEASE_MS = 30_000;
export const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 7200, 14400, 28800];

/** Injection points for tests: a clock and the transports' network/client factories. */
export interface UsageSinkDeps extends TransportDeps {
  now?: () => Date;
}

function deliveryId(prefix: string, sinkId: string, range: string): string {
  const digest = createHash("sha256").update(`${sinkId}:${range}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function nextBoundary(nowMs: number, seconds: number): string {
  const size = seconds * 1000;
  return new Date((Math.floor(nowMs / size) + 1) * size).toISOString();
}

export function aggregateUsageSink(sink: UsageSink, now = new Date()): number {
  if (!sink.enabled) return 0;
  if (sink.mode === "window" && !sink.nextWindowEnd) {
    setNextUsageWindow(sink.id, nextBoundary(now.getTime(), sink.windowSec || 900));
    return 0;
  }
  if (sink.mode === "window" && Date.parse(sink.nextWindowEnd || "") > now.getTime()) return 0;

  const size = (sink.windowSec || 900) * 1000;
  const closedEnd = Math.floor(now.getTime() / size) * size;
  const window =
    sink.mode === "window"
      ? getOrStartUsageWindow(
          sink.id,
          sink.nextWindowEnd || "",
          new Date(Date.parse(sink.nextWindowEnd || "") - size).toISOString(),
          new Date(closedEnd).toISOString(),
          new Date(closedEnd + size).toISOString()
        )
      : null;
  if (sink.mode === "window" && !window) return 0;

  const rows = listCostedUsageAfter(sink.cursorId, PAGE_SIZE, window?.targetId);
  const lastId = rows.at(-1)?.id ?? sink.cursorId;
  const matched =
    sink.apiKeyIds.length === 0
      ? rows
      : rows.filter((row) => sink.apiKeyIds.includes(row.apiKeyId));
  const deliveries: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let nextWindowEnd: string | undefined;
  let completeWindow = false;
  if (sink.mode === "instant") {
    for (const row of matched) {
      const id = deliveryId("ue", sink.id, String(row.id));
      deliveries.push({ id, payload: eventPayload(sink, row, id) });
    }
  } else {
    // The persisted high-water mark keeps later ledger writes out of this
    // window even if draining its source needs several scheduled ticks.
    completeWindow = rows.length < PAGE_SIZE || lastId >= window!.targetId;
    if (completeWindow) nextWindowEnd = window!.nextWindowEnd;
    if (matched.length > 0) {
      const range = { fromId: sink.cursorId + 1, toId: lastId };
      const id = deliveryId("ub", sink.id, `${range.fromId}:${range.toId}`);
      deliveries.push({
        id,
        payload: windowPayload(sink, matched, id, range, window!.startAt, window!.endAt),
      });
    }
  }
  return commitUsageBatch(sink.id, sink.cursorId, lastId, deliveries, nextWindowEnd, completeWindow)
    ? deliveries.length
    : 0;
}

/**
 * Send one payload through the sink's transport. Credentials are decrypted here, for the
 * duration of the call, and the stored config is re-validated so an egress policy that got
 * stricter since the sink was saved applies to sends too.
 */
async function sendViaTransport(
  sink: UsageSink,
  id: string,
  payload: Record<string, unknown>,
  now: Date,
  deps: UsageSinkDeps
): Promise<DeliveryResult> {
  const transport = getTransport(sink.type);
  if (!transport) return permanentFailure(null, `Unknown sink type "${sink.type}"`);
  const decrypted = decryptSecretFields(transport.secretFields, sink.config);
  const unreadable = transport.secretFields.some(
    (key) => typeof sink.config[key] === "string" && sink.config[key] && !decrypted[key]
  );
  if (unreadable) {
    return permanentFailure(
      null,
      "Stored credentials cannot be decrypted (check STORAGE_ENCRYPTION_KEY)"
    );
  }
  const parsed = transport.configSchema.safeParse(decrypted);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ...blankResult(null),
      error: `Configuration is not valid: ${issue?.path.join(".") || "config"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return transport.send(
    { config: parsed.data, id, sinkId: sink.id, payload, now: now.getTime() },
    deps
  );
}

/** Record the outcome of an attempt on a claimed delivery. */
function finishAttempt(
  delivery: UsageDelivery,
  leaseUntil: string,
  result: DeliveryResult,
  now: Date
): void {
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    finishUsageDelivery(delivery.id, leaseUntil, {
      status: "delivered",
      nextAttemptAt: null,
      httpStatus: result.status,
      error: null,
      deliveredAt: now.toISOString(),
    });
    return;
  }
  const dead = !result.retryable || attempts > BACKOFF_SECONDS.length;
  finishUsageDelivery(delivery.id, leaseUntil, {
    status: dead ? "dead" : "pending",
    nextAttemptAt: dead
      ? null
      : new Date(now.getTime() + BACKOFF_SECONDS[attempts - 1] * 1000).toISOString(),
    httpStatus: result.status,
    error: result.error ?? "Delivery failed",
    deliveredAt: null,
  });
}

/** Claim (with a lease) and send one due delivery. False when another worker holds it. */
async function attemptDelivery(
  delivery: UsageDelivery,
  sink: UsageSink,
  now: Date,
  deps: UsageSinkDeps
): Promise<DeliveryResult | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  if (!claimUsageDelivery(delivery.id, now.toISOString(), leaseUntil)) return null;
  let result: DeliveryResult;
  try {
    result = await sendViaTransport(sink, delivery.id, delivery.payload, now, deps);
  } catch (error) {
    // Transports resolve failures instead of throwing; this keeps a bug in one from stranding
    // the delivery in `sending` until its lease runs out.
    console.error(`[RedRouter UsageSinks] Transport ${sink.type} threw:`, error);
    result = { ...blankResult(null), error: "Unexpected transport failure" };
  }
  finishAttempt(delivery, leaseUntil, result, now);
  return result;
}

export async function dispatchUsageDeliveries(
  now = new Date(),
  deps: UsageSinkDeps = {}
): Promise<number> {
  const due = listDueUsageDeliveries(now.toISOString(), 100);
  let attempted = 0;
  for (const delivery of due) {
    const sink = getUsageSink(delivery.sinkId);
    if (!sink?.enabled) continue;
    if (await attemptDelivery(delivery, sink, now, deps)) attempted++;
  }
  return attempted;
}

export type ManualRetryOutcome =
  | { outcome: "not_found" }
  | { outcome: "delivered" }
  | { outcome: "in_flight" }
  | { outcome: "attempted"; result: DeliveryResult };

/**
 * Operator-triggered retry of one delivery, through the same lease and outbox rules as the
 * scheduled dispatch, with the same delivery id so the receiver can still dedupe it. A dead
 * delivery gets a fresh retry budget. It works on a paused sink too: the operator asked.
 */
export async function retryUsageDelivery(
  sinkId: string,
  deliveryId: string,
  deps: UsageSinkDeps = {}
): Promise<ManualRetryOutcome> {
  const sink = getUsageSink(sinkId);
  const current = sink ? getUsageDelivery(sinkId, deliveryId) : null;
  if (!sink || !current) return { outcome: "not_found" };
  if (current.status === "delivered") return { outcome: "delivered" };
  const now = (deps.now ?? (() => new Date()))();
  if (!requeueUsageDelivery(sinkId, deliveryId, now.toISOString())) return { outcome: "in_flight" };
  const delivery = getUsageDelivery(sinkId, deliveryId);
  const result = delivery ? await attemptDelivery(delivery, sink, now, deps) : null;
  return result ? { outcome: "attempted", result } : { outcome: "in_flight" };
}

/**
 * Send a made-up delivery (marked `test: true`, id `test_<uuid>`) right now, outside the outbox
 * and without touching any cursor. `sink` may carry an unsaved config.
 */
export async function sendUsageSinkTest(
  sink: UsageSink,
  deps: UsageSinkDeps = {}
): Promise<DeliveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const id = `test_${randomUUID()}`;
  return sendViaTransport(sink, id, samplePayload(sink, id, now), now, deps);
}

export async function runUsageSinksTick(): Promise<{ created: number; attempted: number }> {
  let created = 0;
  for (const sink of listUsageSinks()) {
    if (!sink.enabled) continue;
    try {
      created += aggregateUsageSink(sink);
    } catch (error) {
      console.error(`[RedRouter UsageSinks] Aggregation failed for ${sink.id}:`, error);
    }
  }
  return { created, attempted: await dispatchUsageDeliveries() };
}
