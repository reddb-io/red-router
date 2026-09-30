import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Migrations 205 (budget rate limits, model caps, tag / user scopes), 206 and 207 (attribution
// columns) on a database that already holds slice-1 data. Each step runs in its own process
// because the runner reads its directory once at import.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDir = path.join(repoRoot, "src/lib/db/migrations");
const coreUrl = pathToFileURL(path.join(repoRoot, "src/lib/db/core.ts")).href;

const PROBE = `
  const { getDbInstance, resetDbInstance } = await import(${JSON.stringify(coreUrl)});
  const db = getDbInstance();
  const action = process.env.PROBE_ACTION;
  if (action === "seed") {
    const now = "2026-09-01T00:00:00.000Z";
    db.prepare("INSERT INTO budgets (id, name, max_usd, duration, on_exceed, throttle_delay_ms, enabled, created_at, updated_at) VALUES ('b1', 'Legacy', 25, 'monthly', 'block', 1000, 1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO budget_assignments (budget_id, scope_type, scope_value, created_at) VALUES ('b1', 'key', 'key-1', ?), ('b1', 'group', 'group-1', ?)").run(now, now);
    db.prepare("INSERT INTO budget_windows (budget_id, scope_value, window_start, spent_usd, alerted_at, updated_at) VALUES ('b1', 'key-1', 1000, 7.5, ?, ?)").run(now, now);
    db.prepare("INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp) VALUES ('key-1', 'openai', 'gpt-4o', 1.25, ?)").run(now);
  }
  if (action === "forget-slice2") {
    db.prepare("DELETE FROM _omniroute_migrations WHERE version IN ('205', '206', '207')").run();
  }
  const columns = (table) => db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name);
  const report = {
    ledger: db.prepare("SELECT version, name, applied_at FROM _omniroute_migrations WHERE version >= '203' ORDER BY version").all(),
    budgets: db.prepare("SELECT * FROM budgets").all().map((r) => ({ id: r.id, name: r.name, max_usd: r.max_usd, tpm_limit: r.tpm_limit ?? null, rpm_limit: r.rpm_limit ?? null, model_max_json: r.model_max_json ?? null })),
    assignments: db.prepare("SELECT budget_id, scope_type, scope_value, created_at FROM budget_assignments ORDER BY scope_type").all(),
    windows: db.prepare("SELECT budget_id, scope_value, window_start, spent_usd, alerted_at FROM budget_windows").all(),
    ledgerRows: db.prepare("SELECT * FROM request_cost_ledger").all().map((r) => ({ api_key_id: r.api_key_id, amount_usd: r.amount_usd, end_user: r.end_user ?? null, tags: r.tags ?? null, session_id: r.session_id ?? null })),
    ledgerColumns: columns("request_cost_ledger"),
    callLogColumns: columns("call_logs"),
    hasModelTable: columns("budget_window_models").length > 0,
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_rcl_end_user_timestamp', 'idx_budget_assignments_budget')").all().map((r) => r.name).sort(),
  };
  if (action === "scopes") {
    const now = "2026-09-02T00:00:00.000Z";
    const insert = (type) => db.prepare("INSERT INTO budget_assignments (budget_id, scope_type, scope_value, created_at) VALUES ('b1', ?, 'x', ?)").run(type, now);
    insert("tag");
    insert("user");
    let rejected = false;
    try { insert("bogus"); } catch { rejected = true; }
    report.scopeChecks = { rejected };
    report.assignments = db.prepare("SELECT scope_type FROM budget_assignments ORDER BY scope_type").all().map((r) => r.scope_type);
  }
  console.log("REPORT:" + JSON.stringify(report));
  resetDbInstance();
`;

type Report = {
  ledger: Array<{ version: string; name: string; applied_at: string }>;
  budgets: Array<Record<string, unknown>>;
  assignments: unknown[];
  windows: Array<Record<string, unknown>>;
  ledgerRows: Array<Record<string, unknown>>;
  ledgerColumns: string[];
  callLogColumns: string[];
  hasModelTable: boolean;
  indexes: string[];
  scopeChecks?: { rejected: boolean };
};

function run(dataDir: string, probeFile: string, action: string, overrideDir?: string): Report {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, PROBE_ACTION: action };
  if (overrideDir) env.OMNIROUTE_MIGRATIONS_DIR = overrideDir;
  else delete env.OMNIROUTE_MIGRATIONS_DIR;
  const result = spawnSync(process.execPath, ["--import", "tsx", probeFile], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("REPORT:"));
  assert.ok(line, "the probe must report");
  return JSON.parse(line.slice("REPORT:".length)) as Report;
}

test("205-207 upgrade a slice-1 database without losing rows, and are safe to run again", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-budgets-slice2-migration-"));
  try {
    const probeFile = path.join(scratch, "probe.mjs");
    fs.writeFileSync(probeFile, PROBE);

    const slice1 = path.join(scratch, "slice1-migrations");
    fs.mkdirSync(slice1);
    for (const file of fs.readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql"))) {
      if (Number.parseInt(file, 10) <= 204) {
        fs.copyFileSync(path.join(migrationsDir, file), path.join(slice1, file));
      }
    }

    const dataDir = path.join(scratch, "data");
    const seeded = run(dataDir, probeFile, "seed", slice1);
    assert.deepEqual(
      seeded.ledger.map((row) => row.version),
      ["203", "204"]
    );
    assert.equal(seeded.ledgerColumns.includes("end_user"), false);
    assert.equal(seeded.hasModelTable, false);

    const upgraded = run(dataDir, probeFile, "scopes");
    assert.deepEqual(
      upgraded.ledger.map((row) => row.version),
      ["203", "204", "205", "206", "207"]
    );
    // Slice-1 rows survive the table rebuild and the new columns default to "no limit".
    assert.deepEqual(upgraded.budgets, [
      {
        id: "b1",
        name: "Legacy",
        max_usd: 25,
        tpm_limit: null,
        rpm_limit: null,
        model_max_json: null,
      },
    ]);
    assert.deepEqual(upgraded.windows, [
      {
        budget_id: "b1",
        scope_value: "key-1",
        window_start: 1000,
        spent_usd: 7.5,
        alerted_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(upgraded.ledgerRows, [
      { api_key_id: "key-1", amount_usd: 1.25, end_user: null, tags: null, session_id: null },
    ]);
    for (const column of ["end_user", "tags", "session_id"]) {
      assert.ok(upgraded.ledgerColumns.includes(column), `request_cost_ledger.${column}`);
    }
    for (const column of ["end_user", "tags"]) {
      assert.ok(upgraded.callLogColumns.includes(column), `call_logs.${column}`);
    }
    assert.equal(upgraded.hasModelTable, true);
    assert.deepEqual(upgraded.indexes, [
      "idx_budget_assignments_budget",
      "idx_rcl_end_user_timestamp",
    ]);
    // The rebuilt table accepts the new scopes, keeps its old two, and still rejects the rest.
    assert.deepEqual(upgraded.assignments, ["group", "key", "tag", "user"]);
    assert.equal(upgraded.scopeChecks?.rejected, true);

    // Opening the migrated database again applies nothing and changes nothing.
    const again = run(dataDir, probeFile, "none");
    assert.deepEqual(again.ledger, upgraded.ledger);
    assert.deepEqual(again.budgets, upgraded.budgets);
    assert.deepEqual(again.windows, upgraded.windows);

    // Forgetting the ledger marks re-runs the files against the already-migrated schema: the
    // runner's "column already exists" path records them and no data moves.
    const forgotten = run(dataDir, probeFile, "forget-slice2");
    assert.deepEqual(
      forgotten.ledger.map((row) => row.version),
      ["203", "204"]
    );
    const replayed = run(dataDir, probeFile, "none");
    assert.deepEqual(
      replayed.ledger.map((row) => row.version),
      ["203", "204", "205", "206", "207"]
    );
    assert.deepEqual(replayed.budgets, upgraded.budgets);
    assert.deepEqual(replayed.windows, upgraded.windows);
    assert.deepEqual(replayed.ledgerRows, upgraded.ledgerRows);
    assert.deepEqual(replayed.indexes, upgraded.indexes);
    const stable = run(dataDir, probeFile, "none");
    assert.deepEqual(
      (stable.assignments as Array<{ scope_type: string }>).map((row) => row.scope_type),
      upgraded.assignments,
      "the replay did not touch the assignments"
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the slice-2 migrations exist under their numbers", () => {
  const files = fs.readdirSync(migrationsDir);
  for (const name of [
    "205_budgets_rate_model_caps_scopes.sql",
    "206_cost_attribution_ledger.sql",
    "207_call_logs_attribution.sql",
  ]) {
    assert.ok(files.includes(name), name);
  }
});
