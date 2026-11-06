import { DatabaseSync } from "node:sqlite";
import { reserveUsageOnDb } from "../../../../src/lib/db/sharedUsageReservation.ts";

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
  raw.close();
  process.stdout.write(JSON.stringify({ allowed }) + "\n", () => process.exit(0));
});
