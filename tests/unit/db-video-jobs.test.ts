import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";

import { createTempDataDir } from "../_setup/tempDataDir.ts";

const { dir, cleanup } = createTempDataDir("omniroute-video-jobs-");
test.after(cleanup);

const core = await import("../../src/lib/db/core.ts");
const jobs = await import("../../src/lib/db/videoJobs.ts");
const requestHash = "a".repeat(64);
const base = {
  owner: "key-owner-1",
  idempotencyKey: "billable-request-1",
  requestHash,
  action: "generations" as const,
  provider: "xai",
  model: "grok-imagine-video",
  connectionId: "connection-1",
};

test("video reservation is durable, owner-scoped, and idempotent", () => {
  const first = jobs.reserveVideoJob(base);
  assert.equal(first.kind, "created");
  const duplicate = jobs.reserveVideoJob({ ...base, connectionId: "connection-2" });
  assert.equal(duplicate.kind, "existing");
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal(duplicate.job.connectionId, "connection-1");

  const conflict = jobs.reserveVideoJob({ ...base, requestHash: "b".repeat(64) });
  assert.equal(conflict.kind, "conflict");
  assert.equal(jobs.getVideoJob(first.job.id, "different-owner"), null);
  assert.equal(jobs.getVideoJob(first.job.id, base.owner)?.state, "reserved");

  assert.equal(jobs.markVideoJobSubmitted(first.job.id, "upstream-job-1"), true);
  assert.equal(jobs.markVideoJobSubmitted(first.job.id, "upstream-job-2"), false);
  assert.equal(jobs.getVideoJob(first.job.id, base.owner)?.upstreamRequestId, "upstream-job-1");
  assert.equal(jobs.getVideoJobByUpstreamId("upstream-job-1", base.owner)?.id, first.job.id);
  assert.equal(jobs.getVideoJobByUpstreamId("upstream-job-1", "different-owner"), null);
});

test("ambiguous submissions remain reserved or uncertain, never auto-retried", () => {
  const first = jobs.reserveVideoJob({ ...base, idempotencyKey: "ambiguous-request" });
  assert.equal(first.kind, "created");
  assert.equal(jobs.markVideoJobUncertain(first.job.id), true);
  assert.equal(jobs.markVideoJobSubmitted(first.job.id, "late-upstream-id"), false);
  assert.equal(
    jobs.reserveVideoJob({ ...base, idempotencyKey: "ambiguous-request" }).job.state,
    "uncertain"
  );
});

test("different owners can use the same idempotency key without collision", () => {
  const first = jobs.reserveVideoJob({ ...base, idempotencyKey: "shared-client-key" });
  const second = jobs.reserveVideoJob({
    ...base,
    owner: "key-owner-2",
    idempotencyKey: "shared-client-key",
  });
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "created");
  assert.notEqual(first.job.id, second.job.id);
});

test("video job contract: no key permits distinct jobs and never stores the raw owner", () => {
  const input = { ...base, idempotencyKey: null };
  const first = jobs.reserveVideoJob(input);
  const second = jobs.reserveVideoJob(input);
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "created");
  assert.notEqual(first.job.id, second.job.id);
  assert.match(first.job.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.notEqual(first.job.ownerHash, base.owner);
  assert.equal(first.job.ownerHash, createHash("sha256").update(base.owner).digest("hex"));
  assert.equal(jobs.getVideoJobByIdempotency(base.owner, "missing-key"), null);
});

test("video job contract: terminal transitions are compare-and-set and cannot resurrect", () => {
  const failed = jobs.reserveVideoJob({ ...base, idempotencyKey: "terminal-failed" });
  assert.equal(failed.kind, "created");
  assert.equal(jobs.markVideoJobFailed(failed.job.id), true);
  assert.equal(jobs.markVideoJobFailed(failed.job.id), false);
  assert.equal(jobs.markVideoJobUncertain(failed.job.id), false);
  assert.equal(jobs.markVideoJobSubmitted(failed.job.id, "late-id"), false);
  assert.equal(jobs.getVideoJob(failed.job.id, base.owner)?.state, "failed");

  const submitted = jobs.reserveVideoJob({ ...base, idempotencyKey: "terminal-submitted" });
  assert.equal(submitted.kind, "created");
  assert.equal(jobs.markVideoJobSubmitted(submitted.job.id, "submitted-id"), true);
  assert.equal(jobs.markVideoJobFailed(submitted.job.id), false);
  assert.equal(jobs.markVideoJobUncertain(submitted.job.id), false);
  assert.equal(jobs.getVideoJob(submitted.job.id, base.owner)?.state, "submitted");
});

test("video job contract: ambiguous native IDs never resolve to an arbitrary job", () => {
  const first = jobs.reserveVideoJob({ ...base, idempotencyKey: "native-collision-1" });
  const second = jobs.reserveVideoJob({ ...base, idempotencyKey: "native-collision-2" });
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "created");
  assert.equal(jobs.markVideoJobSubmitted(first.job.id, "same-provider-id"), true);
  assert.equal(jobs.markVideoJobSubmitted(second.job.id, "same-provider-id"), true);
  assert.equal(jobs.getVideoJobByUpstreamId("same-provider-id", base.owner), null);
});

test("a second SQLite connection cannot reserve the same owner/idempotency key", (t) => {
  const first = jobs.reserveVideoJob({ ...base, idempotencyKey: "two-connection-key" });
  assert.equal(first.kind, "created");
  const db = core.getDbInstance();
  if (db.driver === "sql.js") {
    t.skip("sql.js is not a shared-file SQLite runtime");
    return;
  }

  const second = new DatabaseSync(path.join(dir, "storage.sqlite"), { timeout: 50 });
  try {
    const table = second.prepare("SELECT COUNT(*) AS count FROM video_jobs").get() as {
      count: number;
    };
    assert.ok(table.count >= 1, "the second connection must see the initialized table");

    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    assert.throws(
      () =>
        second
          .prepare(
            `INSERT INTO video_jobs
             (id, owner_hash, idempotency_hash, request_hash, action, provider, model,
              connection_id, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'generations', 'xai', 'grok-imagine-video',
                     'connection-2', 'reserved', ?, ?)`
          )
          .run(
            randomUUID(),
            hash(base.owner),
            hash("two-connection-key"),
            "b".repeat(64),
            new Date().toISOString(),
            new Date().toISOString()
          ),
      { code: "ERR_SQLITE_ERROR", message: /UNIQUE constraint failed/ }
    );
    assert.equal(jobs.getVideoJob(first.job.id, base.owner)?.connectionId, "connection-1");
  } finally {
    second.close();
  }
});
