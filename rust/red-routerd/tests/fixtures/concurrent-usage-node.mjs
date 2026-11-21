// Exercise the TypeScript reservation implementation against the live Rust fixture DB.
import { DatabaseSync } from "node:sqlite";
import { reserveUsageOnDb, cancelUndispatchedUsageOnDb } from "../../../../src/lib/db/sharedUsageReservation.ts";
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
const result = process.argv[2] === "reserve"
  ? reserveUsageOnDb(db, { id: "typescript-live", keyId: "quota", tokens: 150, usd: 0.0004, nowMs: Date.now() })
  : cancelUndispatchedUsageOnDb(db, "typescript-live", "quota");
raw.close();
process.stdout.write(JSON.stringify(result));
