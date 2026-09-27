import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketLogActivity,
  logActivityLevel,
  LOG_ACTIVITY_MINUTE_MS,
  recentLogActivity,
} from "../../src/shared/utils/logActivity.ts";

const now = Date.UTC(2026, 8, 25, 15, 30, 20);
const at = (minutesAgo: number, level = "info") => ({
  timestamp: now - minutesAgo * LOG_ACTIVITY_MINUTE_MS,
  level,
});

test("console activity normalizes structured levels and plain log markers", () => {
  assert.equal(logActivityLevel({ level: "fatal" }), "error");
  assert.equal(logActivityLevel({ level: "trace" }), "debug");
  assert.equal(logActivityLevel({ level: "info", msg: "⚠️ slow" }), "warn");
  assert.equal(logActivityLevel({ level: "info", message: "Error: boom" }), "error");
});

test("console activity counts recent minutes and ignores missing or invalid timestamps", () => {
  const buckets = bucketLogActivity(
    [at(0), at(0, "warn"), at(1, "error"), at(29), at(31), { timestamp: "bad" }, {}],
    now,
    30
  );
  assert.equal(buckets.length, 30);
  assert.deepEqual(
    { info: buckets[29].info, warn: buckets[29].warn, total: buckets[29].total },
    { info: 1, warn: 1, total: 2 }
  );
  assert.equal(buckets[28].error, 1);
  assert.equal(buckets[0].total, 1);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    4
  );
  assert.equal(
    buckets[29].start,
    Math.floor(now / LOG_ACTIVITY_MINUTE_MS) * LOG_ACTIVITY_MINUTE_MS
  );
});

test("console activity summarizes the last five minutes", () => {
  const buckets = bucketLogActivity(
    [at(0), at(1, "error"), at(2, "warn"), at(3), at(4), at(9)],
    now,
    30
  );
  assert.deepEqual(recentLogActivity(buckets), { total: 5, perMinute: 1, warn: 1, error: 1 });
});
