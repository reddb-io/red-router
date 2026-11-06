import { DatabaseSync } from "node:sqlite";
import { reserveUsageOnDb, settleUsageOnDb, markUsageDispatchedOnDb, cancelUndispatchedUsageOnDb } from "../../../../src/lib/db/sharedUsageReservation.ts";

const raw = new DatabaseSync(process.env.RED_ROUTER_TEST_SQLITE);
raw.exec("PRAGMA busy_timeout = 10000");
const db = {
  driver: "node:sqlite",
  prepare(sql) {
    const statement = raw.prepare(sql);
    return { get: (...params) => statement.get(...params), run: (...params) => statement.run(...params) };
  },
  immediate(fn) {
    raw.exec("BEGIN IMMEDIATE");
    try { fn(); raw.exec("COMMIT"); } catch (error) { raw.exec("ROLLBACK"); throw error; }
  },
};
process.stdout.write("ready\n");
process.stdin.once("data", () => {
  let allowed = 0;
  for (let i = 0; i < 16; i++) {
    if (reserveUsageOnDb(db, { id: `node-${i}`, keyId: "key", tokens: 10, usd: 0.01, nowMs: 1_700_000_000_000 })) allowed++;
  }
  const event = { id: "rust-handoff", keyId: "node-key", nowMs: 1_700_000_000_000, provider: "openai", model: "gpt", input: 100, output: 50,
    reasoning: 0, cacheRead: 0, cacheCreation: 0, prices: { input: 2, output: 4, cached: 2, cacheCreation: 2, reasoning: 4 } };
  const settled = settleUsageOnDb(db, event);
  const duplicate = settleUsageOnDb(db, event);
  let collision = false;
  try { settleUsageOnDb(db, { ...event, output: 51 }); } catch { collision = true; }
  const overrunReservation = reserveUsageOnDb(db, { id: "node-overrun", keyId: "node-key", tokens: 10, usd: 0.001, nowMs: event.nowMs });
  const dispatched = markUsageDispatchedOnDb(db, "node-overrun", "node-key");
  const cancelled = cancelUndispatchedUsageOnDb(db, "node-overrun", "node-key");
  let overrun = false;
  try { settleUsageOnDb(db, { ...event, id: "node-overrun" }); } catch { overrun = true; }
  raw.close();
  process.stdout.write(JSON.stringify({ allowed, settled, duplicate, collision, overrunReservation, dispatched, cancelled, overrun }) + "\n", () => process.exit(0));
});
