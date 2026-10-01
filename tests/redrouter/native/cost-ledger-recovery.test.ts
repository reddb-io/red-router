import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-cost-recovery-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const ledger = await import("../../../src/lib/db/costLedger.ts");
const db = getDbInstance();
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("a failed ledger write remains durable and replay is idempotent after recovery", () => {
  db.exec(
    "CREATE TRIGGER reject_cost BEFORE INSERT ON request_cost_ledger BEGIN SELECT RAISE(ABORT, 'fixture'); END"
  );
  const event = {
    apiKeyId: "fixture",
    provider: "openai",
    model: "fixture",
    amountUsd: 0.25,
    requestId: "event-1",
  };
  assert.equal(ledger.recordLedgerEntrySafe(event), "queued");
  assert.equal(ledger.getCostLedgerHealth().pendingEvents, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM request_cost_ledger").get() as { n: number }).n,
    0
  );
  db.exec("DROP TRIGGER reject_cost");
  ledger.flushCostLedgerOutbox();
  ledger.flushCostLedgerOutbox();
  assert.equal(ledger.recordLedgerEntrySafe(event), "recorded");
  const row = db
    .prepare("SELECT COUNT(*) AS n, SUM(amount_usd) AS amount FROM request_cost_ledger")
    .get() as { n: number; amount: number };
  assert.deepEqual(row, { n: 1, amount: 0.25 });
  assert.equal(ledger.getCostLedgerHealth().pendingEvents, 0);
});

test("the same upstream request ID on another key remains a distinct cost event", () => {
  ledger.recordLedgerEntrySafe({
    apiKeyId: "other-key",
    provider: "openai",
    model: "fixture",
    amountUsd: 1,
    requestId: "event-1",
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM request_cost_ledger").get() as { n: number }).n,
    2
  );
});
