// Usage sinks engine: Aggregator + transactional outbox.
//
// Each tick, for every active sink:
//   instant — each new usage row becomes one delivery;
//   window  — when the clock passes the sink's window end, every usage row
//             recorded since the cursor becomes one per-API-key batch.
// Rows are read by log position (usageHistory.id), so a request that finished
// after a boundary lands in the next window, counted once, with no watermark.
// Deliveries and the cursor move in one transaction (commitSinkBatch); sending
// happens afterwards from the outbox, at least once, with a deterministic id
// the consumer dedupes on.
import * as repo from "@/lib/db/repos/usageSinksRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import {
  buildKeyResolver, matchesFilter, buildEventPayload, buildWindowPayload, windowBatchId, eventBatchId,
} from "./payload.js";
import { TRANSPORTS } from "./transports.js";

const INSTANT_BATCH = 200;
const WINDOW_BATCH = 50_000;
// Retry schedule after a failed attempt; a delivery is dead once it runs out (~16h).
export const BACKOFF_SEC = [30, 120, 600, 1800, 3600, 7200, 14400, 28800];

const SENDERS = Object.fromEntries(Object.entries(TRANSPORTS).map(([type, t]) => [type, t.send]));

export function createDefaultDeps() {
  return { repo, getApiKeys, transports: SENDERS, now: () => new Date() };
}

/** The window boundary at or after `ms`, for windows of `sizeSec` aligned to the UTC epoch. */
export function nextBoundary(ms, sizeSec) {
  const size = sizeSec * 1000;
  return Math.floor(ms / size) * size + size;
}

async function aggregateInstant(sink, deps, resolveKey) {
  const rows = await deps.repo.getUsageRowsAfter(sink.cursorId, { limit: INSTANT_BATCH });
  if (!rows.length) return 0;
  const deliveries = [];
  for (const row of rows) {
    const identity = resolveKey(row.apiKey);
    if (!matchesFilter(sink.filter, identity)) continue;
    const id = eventBatchId(sink.id, row.id);
    deliveries.push({ id, kind: "event", fromId: row.id, toId: row.id, payload: buildEventPayload({ sink, row, identity, id }) });
  }
  const lastId = rows[rows.length - 1].id;
  await deps.repo.commitSinkBatch(sink.id, sink.cursorId, lastId, deliveries, {}, deps.now());
  return deliveries.length;
}

async function aggregateWindow(sink, deps, resolveKey) {
  const sizeSec = sink.windowSec;
  const nowMs = deps.now().getTime();
  if (!sink.nextWindowEnd) {
    // First run (or a new size): the first window closes at the next boundary.
    await deps.repo.setSinkNextWindowEnd(sink.id, new Date(nextBoundary(nowMs, sizeSec)).toISOString());
    return 0;
  }
  const windowEndMs = Date.parse(sink.nextWindowEnd);
  if (nowMs < windowEndMs) return 0;

  // After downtime several windows may have passed: one batch covers them all,
  // labelled from the missed window's start to the last boundary reached.
  const closedEndMs = Math.floor(nowMs / (sizeSec * 1000)) * sizeSec * 1000;
  const window = {
    start: new Date(windowEndMs - sizeSec * 1000).toISOString(),
    end: new Date(closedEndMs).toISOString(),
    sizeSec,
  };
  const nextWindowEnd = new Date(closedEndMs + sizeSec * 1000).toISOString();

  const rows = await deps.repo.getUsageRowsAfter(sink.cursorId, { limit: WINDOW_BATCH });
  const matched = rows.filter((row) => matchesFilter(sink.filter, resolveKey(row.apiKey)));
  const lastId = rows.length ? rows[rows.length - 1].id : sink.cursorId;
  const deliveries = [];
  // An empty window sends nothing; the contiguous range lets consumers spot gaps.
  if (matched.length) {
    const range = { fromId: sink.cursorId + 1, toId: lastId };
    const id = windowBatchId(sink.id, range.fromId, range.toId);
    deliveries.push({
      id, kind: "window", windowStart: window.start, windowEnd: window.end, fromId: range.fromId, toId: range.toId,
      payload: buildWindowPayload({ sink, rows: matched, resolveKey, window, range, id }),
    });
  }
  await deps.repo.commitSinkBatch(sink.id, sink.cursorId, lastId, deliveries, { nextWindowEnd }, deps.now());
  return deliveries.length;
}

/** Turn new usage into deliveries for every active sink. */
export async function aggregate(deps = createDefaultDeps()) {
  const sinks = (await deps.repo.getUsageSinks()).filter((s) => s.isActive);
  if (!sinks.length) return 0;
  const resolveKey = buildKeyResolver(await deps.getApiKeys());
  let created = 0;
  for (const sink of sinks) {
    try {
      created += sink.mode === "window" ? await aggregateWindow(sink, deps, resolveKey) : await aggregateInstant(sink, deps, resolveKey);
    } catch (e) {
      console.warn(`[UsageSinks] aggregate ${sink.name}: ${e.message}`);
    }
  }
  return created;
}

/** Send one delivery now and record the outcome (used by the tick and by manual retry). */
export async function attemptDelivery(delivery, sink, deps = createDefaultDeps()) {
  const send = deps.transports[sink.type];
  const now = deps.now();
  const attempts = delivery.attempts + 1;
  const result = send
    ? await send({ config: sink.config, id: delivery.id, payload: delivery.payload, now: now.getTime(), sinkId: sink.id })
    : { ok: false, retryable: false, error: `Unknown sink type "${sink.type}"` };
  if (result.ok) {
    await deps.repo.markDeliveryResult(delivery.id, {
      status: "delivered", attempts, deliveredAt: now.toISOString(), lastStatus: result.status, lastError: null, nextAttemptAt: null,
    });
  } else {
    const dead = result.retryable === false || attempts > BACKOFF_SEC.length;
    await deps.repo.markDeliveryResult(delivery.id, {
      status: dead ? "dead" : "pending",
      attempts,
      lastStatus: result.status,
      lastError: result.error,
      nextAttemptAt: dead ? null : new Date(now.getTime() + BACKOFF_SEC[attempts - 1] * 1000).toISOString(),
    });
  }
  return result;
}

/** Send every delivery that is due, for active sinks. */
export async function dispatch(deps = createDefaultDeps()) {
  const due = await deps.repo.getDueDeliveries(deps.now());
  if (!due.length) return 0;
  const sinks = new Map((await deps.repo.getUsageSinks()).map((s) => [s.id, s]));
  let sent = 0;
  for (const delivery of due) {
    const sink = sinks.get(delivery.sinkId);
    if (!sink?.isActive) continue; // a paused sink keeps its queue
    await attemptDelivery(delivery, sink, deps);
    sent++;
  }
  return sent;
}

export async function runUsageSinksTick(deps = createDefaultDeps(), state = { running: false }) {
  if (state.running) return;
  state.running = true;
  try {
    await aggregate(deps);
    await dispatch(deps);
  } catch (e) {
    console.warn("[UsageSinks] tick error:", e.message);
  } finally {
    state.running = false;
  }
}
