import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-shared-rpm-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { upsertKeyQuotaLimits, reserveSharedKeyRpm, getQuotaWindowCount } =
  await import("../../../src/lib/db/keyQuota.ts");
const { recordKeyQuotaUsage } = await import("../../../src/domain/keyQuota.ts");

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("shared RPM admission is durable and completion only adds tokens", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  upsertKeyQuotaLimits("shared-client", { rpmLimit: 2 });
  assert.equal(reserveSharedKeyRpm("shared-client", now), true);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 1), true);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 2), false);
  recordKeyQuotaUsage("shared-client", 15, { now: () => now + 3, skipRpm: true });
  assert.equal(getQuotaWindowCount("shared-client", "key-quota:rpm", now + 3), 2);
  assert.equal(getQuotaWindowCount("shared-client", "key-quota:tpm", now + 3), 15);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 60_000), false);
  assert.equal(reserveSharedKeyRpm("shared-client", now + 90_000), true);
  const row = getDbInstance()
    .prepare("SELECT SUM(consumed) AS n FROM api_key_quota_counters WHERE api_key_id = ? AND dimension_key = ?")
    .get("shared-client", "key-quota:rpm") as { n: number };
  assert.equal(row.n, 3);
});
