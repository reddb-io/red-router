import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The migration ledger is keyed by version number. RedRouter owns 190-194 (video jobs,
// API-key daily token quota, usage sinks, usage window watermarks, usage sink transports)
// while OmniRoute later used the same numbers for unrelated migrations. The upstream ones
// were renumbered to 195-201 in the v3.8.52 sync so that:
//   - a database migrated by a RedRouter build (ledger up to 194) applies every new
//     migration exactly once and never re-runs or renames one it already recorded;
//   - a fresh install applies everything.
// Each scenario runs in its own process because the runner reads its directory once at import.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDir = path.join(repoRoot, "src/lib/db/migrations");
const coreUrl = pathToFileURL(path.join(repoRoot, "src/lib/db/core.ts")).href;

const REDROUTER_SHIPPED = [
  ["190", "video_jobs"],
  ["191", "api_key_daily_token_quota"],
  ["192", "redrouter_cost_usage_sinks"],
  ["193", "redrouter_usage_window_watermarks"],
  ["194", "redrouter_usage_sink_transports"],
];

type LedgerRow = { version: string; name: string; applied_at: string };

function probeSource(): string {
  return `
    const { getDbInstance, resetDbInstance } = await import(${JSON.stringify(coreUrl)});
    const db = getDbInstance();
    const ledger = db
      .prepare("SELECT version, name, applied_at FROM _omniroute_migrations ORDER BY version")
      .all();
    const columns = (table) =>
      db.prepare("PRAGMA table_info(" + table + ")").all().map((column) => column.name);
    console.log(
      "LEDGER:" +
        JSON.stringify({
          ledger,
          headersMs: columns("proxy_logs").includes("headers_ms"),
          selectorControl: columns("proxy_subscriptions").includes("selector_min_gap_seconds"),
          tokenLimitWindowUnique: /reset_interval\\)/.test(
            db.prepare("SELECT sql FROM sqlite_master WHERE name = 'api_key_token_limits'").get().sql
          ),
        })
    );
    resetDbInstance();
  `;
}

function runProbe(dataDir: string, probeFile: string, overrideDir?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir };
  if (overrideDir) env.OMNIROUTE_MIGRATIONS_DIR = overrideDir;
  else delete env.OMNIROUTE_MIGRATIONS_DIR;
  const result = spawnSync(process.execPath, ["--import", "tsx", probeFile], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("LEDGER:"));
  assert.ok(line, "probe must report the ledger");
  return JSON.parse(line.slice("LEDGER:".length)) as {
    ledger: LedgerRow[];
    headersMs: boolean;
    selectorControl: boolean;
    tokenLimitWindowUnique: boolean;
  };
}

test("upstream migrations from the v3.8.52 sync never collide with shipped RedRouter versions", () => {
  const byVersion = new Map<string, string>();
  for (const file of fs.readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql"))) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    assert.ok(match, file);
    assert.equal(byVersion.has(match[1]), false, `version ${match[1]} is used twice`);
    byVersion.set(match[1], match[2]);
  }
  for (const [version, name] of REDROUTER_SHIPPED) {
    assert.equal(byVersion.get(version), name, `shipped RedRouter migration ${version}`);
  }
  assert.equal(byVersion.get("195"), "call_logs_content_provenance");
  assert.equal(byVersion.get("199"), "proxy_logs_attempt_timing");
  assert.equal(byVersion.get("201"), "token_limits_unique_per_window");
});

test("a RedRouter database (ledger up to 194) upgrades and a fresh install migrates everything once", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-migration-ledger-"));
  try {
    const probeFile = path.join(scratch, "probe.mjs");
    fs.writeFileSync(probeFile, probeSource());

    const shipped = path.join(scratch, "shipped-migrations");
    fs.mkdirSync(shipped);
    for (const file of fs.readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql"))) {
      if (Number.parseInt(file, 10) <= 194) {
        fs.copyFileSync(path.join(migrationsDir, file), path.join(shipped, file));
      }
    }

    const upgradeData = path.join(scratch, "upgrade");
    const before = runProbe(upgradeData, probeFile, shipped);
    assert.equal(before.ledger.at(-1)?.version, "194");
    assert.equal(before.selectorControl, false);

    const after = runProbe(upgradeData, probeFile);
    const versions = after.ledger.map((row) => row.version);
    assert.deepEqual(versions, [...new Set(versions)], "every version is recorded exactly once");
    assert.deepEqual(
      // Migrations after 201 are RedRouter's own and change with every release.
      versions.filter((version) => Number(version) >= 190 && Number(version) <= 201),
      ["190", "191", "192", "193", "194", "195", "196", "197", "198", "199", "200", "201"]
    );
    for (const row of before.ledger.filter((entry) => Number(entry.version) >= 190)) {
      const same = after.ledger.find((entry) => entry.version === row.version);
      assert.deepEqual(same, row, `shipped migration ${row.version} must not be re-applied`);
    }
    assert.equal(after.headersMs && after.selectorControl && after.tokenLimitWindowUnique, true);

    const fresh = runProbe(path.join(scratch, "fresh"), probeFile);
    assert.deepEqual(
      fresh.ledger.map((row) => [row.version, row.name]),
      after.ledger.map((row) => [row.version, row.name])
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
