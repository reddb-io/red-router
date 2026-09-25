// Usage sinks and their delivery outbox (see src/lib/usageSinks/).
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const SINK_TYPES = ["webhook"];
export const SINK_MODES = ["instant", "window"];
export const WINDOW_SIZES_SEC = [300, 900, 1800, 3600];

function rowToSink(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config, {}) || {},
    mode: row.mode,
    windowSec: row.windowSec ?? null,
    filter: parseJson(row.filter, null),
    isActive: row.isActive === 1 || row.isActive === true,
    cursorId: Number(row.cursorId || 0),
    nextWindowEnd: row.nextWindowEnd || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    sinkId: row.sinkId,
    kind: row.kind,
    windowStart: row.windowStart || null,
    windowEnd: row.windowEnd || null,
    fromId: row.fromId ?? null,
    toId: row.toId ?? null,
    payload: parseJson(row.payload, null),
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.nextAttemptAt || null,
    lastError: row.lastError || null,
    lastStatus: row.lastStatus ?? null,
    deliveredAt: row.deliveredAt || null,
    createdAt: row.createdAt,
  };
}

export async function getUsageSinks() {
  const db = await getDb();
  const rows = await db.selectFrom("usageSinks").selectAll().orderBy("createdAt", "asc").execute();
  return rows.map(rowToSink);
}

export async function getUsageSinkById(id) {
  const db = await getDb();
  return rowToSink(await db.selectFrom("usageSinks").selectAll().where("id", "=", id).executeTakeFirst());
}

/** The highest usageHistory id right now: a new sink starts from here, not from history. */
export async function getUsageHeadId() {
  const db = await getDb();
  const row = await db.selectFrom("usageHistory").select((eb) => eb.fn.max("id").as("maxId")).executeTakeFirst();
  return Number(row?.maxId || 0);
}

export async function createUsageSink(input) {
  const db = await getDb();
  const now = new Date().toISOString();
  const sink = {
    id: uuidv4(),
    name: input.name,
    type: input.type,
    config: stringifyJson(input.config || {}),
    mode: input.mode,
    windowSec: input.mode === "window" ? input.windowSec : null,
    filter: input.filter ? stringifyJson(input.filter) : null,
    isActive: input.isActive === false ? 0 : 1,
    cursorId: await getUsageHeadId(),
    nextWindowEnd: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insertInto("usageSinks").values(sink).execute();
  return getUsageSinkById(sink.id);
}

export async function updateUsageSink(id, patch) {
  const db = await getDb();
  const set = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.config !== undefined) set.config = stringifyJson(patch.config || {});
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.windowSec !== undefined) set.windowSec = patch.windowSec;
  if (patch.filter !== undefined) set.filter = patch.filter ? stringifyJson(patch.filter) : null;
  if (patch.isActive !== undefined) set.isActive = patch.isActive ? 1 : 0;
  // A new window size or mode starts a fresh schedule at the next boundary.
  if (patch.mode !== undefined || patch.windowSec !== undefined) set.nextWindowEnd = null;
  await db.updateTable("usageSinks").set(set).where("id", "=", id).execute();
  return getUsageSinkById(id);
}

export async function deleteUsageSink(id) {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("usageDeliveries").where("sinkId", "=", id).execute();
    await trx.deleteFrom("usageSinks").where("id", "=", id).execute();
  });
}

export async function setSinkNextWindowEnd(id, nextWindowEnd) {
  const db = await getDb();
  await db.updateTable("usageSinks").set({ nextWindowEnd }).where("id", "=", id).execute();
}

/** Usage rows after `afterId` (inclusive of `upToId` when given), oldest first. */
export async function getUsageRowsAfter(afterId, { upToId = null, limit = 5000 } = {}) {
  const db = await getDb();
  let q = db.selectFrom("usageHistory")
    .select(["id", "timestamp", "provider", "model", "connectionId", "apiKey", "endpoint", "promptTokens", "completionTokens", "cost", "status", "tokens"])
    .where("id", ">", afterId);
  if (upToId !== null) q = q.where("id", "<=", upToId);
  const rows = await q.orderBy("id", "asc").limit(limit).execute();
  return rows.map((r) => ({ ...r, id: Number(r.id), tokens: parseJson(r.tokens, {}) || {} }));
}

/**
 * Store deliveries and move the sink's cursor in one transaction. The cursor
 * only moves from `expectedCursor` (compare-and-set), so when two instances
 * share one database only the first turns a range into deliveries; the other
 * gets false and writes nothing. A delivery whose id already exists is kept
 * as is (same batch, same webhook-id).
 */
export async function commitSinkBatch(sinkId, expectedCursor, nextCursor, deliveries, extra = {}, at = new Date()) {
  const db = await getDb();
  // The engine's clock, so a new delivery is due on the same clock that dispatches it.
  const now = at.toISOString();
  return db.transaction().execute(async (trx) => {
    const res = await trx.updateTable("usageSinks")
      .set({ cursorId: nextCursor, updatedAt: now, ...extra })
      .where("id", "=", sinkId)
      .where("cursorId", "=", expectedCursor)
      .executeTakeFirst();
    if (Number(res?.numUpdatedRows ?? 0) !== 1) return false;
    for (const d of deliveries) {
      await trx.insertInto("usageDeliveries").values({
        id: d.id,
        sinkId,
        kind: d.kind,
        windowStart: d.windowStart || null,
        windowEnd: d.windowEnd || null,
        fromId: d.fromId ?? null,
        toId: d.toId ?? null,
        payload: stringifyJson(d.payload),
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        lastStatus: null,
        deliveredAt: null,
        createdAt: now,
      }).onConflict((oc) => oc.column("id").doNothing()).execute();
    }
    return true;
  });
}

export async function getDueDeliveries(now = new Date(), limit = 20) {
  const db = await getDb();
  const rows = await db.selectFrom("usageDeliveries").selectAll()
    .where("status", "=", "pending")
    .where("nextAttemptAt", "<=", now.toISOString())
    .orderBy("createdAt", "asc")
    .limit(limit)
    .execute();
  return rows.map(rowToDelivery);
}

export async function getDeliveries(sinkId, { limit = 50 } = {}) {
  const db = await getDb();
  const rows = await db.selectFrom("usageDeliveries").selectAll()
    .where("sinkId", "=", sinkId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .execute();
  return rows.map(rowToDelivery);
}

export async function getDeliveryById(id) {
  const db = await getDb();
  return rowToDelivery(await db.selectFrom("usageDeliveries").selectAll().where("id", "=", id).executeTakeFirst());
}

export async function markDeliveryResult(id, patch) {
  const db = await getDb();
  await db.updateTable("usageDeliveries").set(patch).where("id", "=", id).execute();
}

/** Per-sink delivery counts by status, for the dashboard list. */
export async function getDeliveryStats() {
  const db = await getDb();
  const rows = await db.selectFrom("usageDeliveries")
    .select(["sinkId", "status", (eb) => eb.fn.countAll().as("n")])
    .groupBy(["sinkId", "status"])
    .execute();
  const stats = {};
  for (const r of rows) {
    stats[r.sinkId] ||= { pending: 0, delivered: 0, dead: 0 };
    stats[r.sinkId][r.status] = Number(r.n);
  }
  return stats;
}
