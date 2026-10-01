import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { readBackupUpload, BackupUploadError } from "../../../src/lib/recovery/upload.ts";

function upload(body: BodyInit, headers: HeadersInit = {}) {
  return new Request("http://localhost/import?filename=snapshot.sqlite", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
}
const oversized = (error: unknown) => error instanceof BackupUploadError && error.status === 413;

test("backup import rejects declared and actual chunked sizes before accepting a file", async () => {
  await assert.rejects(readBackupUpload(upload("", { "content-length": "8193" }), 8192), oversized);
  let cancelled = false;
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      count++;
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readBackupUpload(upload(stream, { "content-length": "1" }), 8192),
    oversized
  );
  assert.ok(count < 6, "the oversized stream is cancelled rather than drained");
  assert.equal(cancelled, true);
});

test("raw upload writes each chunk completely to a private temporary file", async () => {
  const contents = new Uint8Array(8192).fill(17);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(contents.subarray(0, 3071));
      controller.enqueue(contents.subarray(3071));
      controller.close();
    },
  });
  const result = await readBackupUpload(upload(stream), contents.length);
  try {
    assert.deepEqual(await fs.readFile(result.filePath), Buffer.from(contents));
    if (process.platform !== "win32")
      assert.equal((await fs.stat(result.filePath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(result.directory, { recursive: true, force: true });
  }
});

test("multipart bounds both the uploaded file and entire envelope", async () => {
  const oversizedFile = new FormData();
  oversizedFile.set("file", new File([new Uint8Array(8193)], "db.sqlite"));
  await assert.rejects(readBackupUpload(upload(oversizedFile), 8192), oversized);
  const oversizedEnvelope = new FormData();
  oversizedEnvelope.set("file", new File([new Uint8Array(8192)], "db.sqlite"));
  oversizedEnvelope.set("extra", "x".repeat(70 * 1024));
  await assert.rejects(readBackupUpload(upload(oversizedEnvelope), 8192), oversized);
  const valid = new FormData();
  valid.set("file", new File([new Uint8Array(4096)], "db.sqlite"));
  const result = await readBackupUpload(upload(valid), 8192);
  assert.equal(result.filename, "db.sqlite");
  await fs.rm(result.directory, { recursive: true, force: true });
});
