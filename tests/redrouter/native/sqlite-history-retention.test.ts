import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "redrouter-history-retention-"));
process.env.DATA_DIR = dir;
process.env.RED_ROUTER_DATA_DIR = dir;
const core = await import("../../../src/lib/db/core.ts");
const settings = await import("../../../src/lib/db/databaseSettings.ts");
const policy = await import("../../../src/lib/db/historyRetentionPolicy.ts");
const { cleanupSqliteHistory } = await import("../../../src/lib/db/sqliteHistoryRetention.ts");
const { runAutoCleanup } = await import("../../../src/lib/db/cleanup.ts");
const { cleanupExpiredLogs } = await import("../../../src/lib/compliance/index.ts");
const { pruneRuns } = await import("../../../src/lib/db/jobRegistryDb.ts");
const { databaseSettingsSchema } =
  await import("../../../src/shared/validation/settingsSchemas.ts");
let db = core.getDbInstance();
const now = Date.UTC(2026, 9, 3, 12);
const old = new Date(now - 40 * 86_400_000).toISOString();
const recent = new Date(now - 86_400_000).toISOString();
const rowCount = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const setWindow = (days: 0 | 7 | 14 | 28 | null) =>
  settings.updateDatabaseSettings({
    retention: { ...settings.getUserDatabaseSettings().retention, historyWindowDays: days },
  });

beforeEach(() => {
  for (const table of [
    "request_detail_logs",
    "call_logs",
    "proxy_logs",
    "job_runs",
    "usage_history",
    "request_cost_ledger",
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  setWindow(null);
});
after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

function seedHistory() {
  db.prepare(
    "INSERT INTO request_detail_logs (id, timestamp, client_request) VALUES (?, ?, ?)"
  ).run("old", old, "old payload");
  db.prepare("INSERT INTO request_detail_logs (id, timestamp) VALUES (?, ?)").run("recent", recent);
  db.prepare("INSERT INTO call_logs (id, timestamp) VALUES (?, ?)").run("old", old);
  db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES (?, ?, ?)").run(
    "budget_reset",
    old,
    "success"
  );
  db.prepare("INSERT INTO job_runs (job_id, started_at, status) VALUES (?, ?, ?)").run(
    "budget_reset",
    old,
    "running"
  );
  db.prepare("INSERT INTO usage_history (timestamp, provider, model) VALUES (?, ?, ?)").run(
    old,
    "provider",
    "model"
  );
  db.prepare(
    "INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp) VALUES (?, ?, ?, ?, ?)"
  ).run("personal-key", "provider", "model", 3, old);
}

test("fresh settings preserve existing rules, presets persist through singleton restart", () => {
  assert.equal(policy.getHistoryWindowDays(), null);
  setWindow(14);
  assert.equal(policy.getHistoryWindowDays(), 14);
  core.resetDbInstance();
  assert.equal(policy.getHistoryWindowDays(), 14);
  db = core.getDbInstance();
});

for (const days of [7, 14, 28] as const) {
  test(`${days} days removes expired operational rows, retaining recent rows, live tasks and financial history`, async () => {
    setWindow(days);
    seedHistory();
    const result = await cleanupSqliteHistory(days, now);
    assert.equal(result.totalErrors, 0);
    assert.ok(result.totalDeleted >= 3);
    assert.equal(rowCount("request_detail_logs"), 1);
    assert.equal(rowCount("call_logs"), 0);
    assert.equal(rowCount("job_runs"), 1);
    assert.equal(rowCount("usage_history"), 1);
    assert.equal(rowCount("request_cost_ledger"), 1);
    assert.equal((await cleanupSqliteHistory(days, now)).totalDeleted, 0);
  });
}

test("Off also stops the legacy compliance cleaner and per-job pruning", async () => {
  setWindow(0);
  seedHistory();
  assert.equal((await runAutoCleanup()).totalDeleted, 0);
  await cleanupExpiredLogs();
  pruneRuns("budget_reset", 0, 1);
  assert.equal(rowCount("request_detail_logs"), 2);
  assert.equal(rowCount("call_logs"), 1);
  assert.equal(rowCount("job_runs"), 2);
});

test("SQLite-formatted timestamps respect the exact cutoff within the boundary day", async () => {
  setWindow(7);
  const cutoff = now - 7 * 86_400_000;
  const asSqlite = (value: number) => new Date(value).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("INSERT INTO proxy_logs (id, timestamp) VALUES (?, ?)").run(
    "expired",
    asSqlite(cutoff - 1000)
  );
  db.prepare("INSERT INTO proxy_logs (id, timestamp) VALUES (?, ?)").run(
    "boundary",
    asSqlite(cutoff)
  );
  db.prepare("INSERT INTO proxy_logs (id, timestamp) VALUES (?, ?)").run(
    "recent",
    asSqlite(cutoff + 1000)
  );
  await cleanupSqliteHistory(7, now);
  assert.equal(rowCount("proxy_logs"), 2);
});

test("the settings contract rejects arbitrary or negative history windows", () => {
  const retention = settings.getUserDatabaseSettings().retention;
  for (const historyWindowDays of [0, 7, 14, 28, null])
    assert.equal(
      databaseSettingsSchema.partial().safeParse({ retention: { ...retention, historyWindowDays } })
        .success,
      true
    );
  for (const historyWindowDays of [-1, 1, 365, "7", false])
    assert.equal(
      databaseSettingsSchema.partial().safeParse({ retention: { ...retention, historyWindowDays } })
        .success,
      false
    );
});

for (const days of [7, 14, 28] as const) {
  test(`${days} days keeps records inside the selected window`, async () => {
    setWindow(days);
    const insert = db.prepare("INSERT INTO proxy_logs (id, timestamp) VALUES (?, ?)");
    for (const age of [1, 10, 20, 40]) {
      insert.run(String(age), new Date(now - age * 86_400_000).toISOString());
    }
    await cleanupSqliteHistory(days, now);
    assert.equal(rowCount("proxy_logs"), [1, 10, 20, 40].filter((age) => age < days).length);
  });
}

test("saving Off stops further batches in a running cleanup", async () => {
  setWindow(7);
  const insert = db.prepare("INSERT INTO call_logs (id, timestamp) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 2001; i++) insert.run(String(i), old);
  })();
  const cleanup = cleanupSqliteHistory(7, now);
  // The first bounded batch runs before the initial yield.
  setWindow(0);
  const result = await cleanup;
  assert.equal(result.totalDeleted, 1000);
  assert.equal(rowCount("call_logs"), 1001);
});

test("table failures remain visible in the result and diagnostic logs", async () => {
  setWindow(7);
  db.prepare("INSERT INTO proxy_logs (id, timestamp) VALUES (?, ?)").run("old", old);
  db.exec(
    "CREATE TEMP TRIGGER fail_history_cleanup BEFORE DELETE ON proxy_logs BEGIN SELECT RAISE(ABORT, 'cleanup blocked'); END"
  );
  const errors = mock.method(console, "error", () => {});
  try {
    const result = await cleanupSqliteHistory(7, now);
    assert.equal(result.totalErrors, 1);
    assert.equal(rowCount("proxy_logs"), 1);
    assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes("proxy_logs")));
  } finally {
    errors.mock.restore();
    db.exec("DROP TRIGGER fail_history_cleanup");
  }
});
