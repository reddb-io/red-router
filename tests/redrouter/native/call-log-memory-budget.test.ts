import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  __setCallLogWorkerOverrideForTests,
  closeCallLogArtifactWriter,
  writeCallArtifactAsync,
} from "../../../src/lib/usage/callLogArtifactWriter.ts";
import type { CallLogArtifact } from "../../../src/lib/usage/callLogArtifacts.ts";

__setCallLogWorkerOverrideForTests({
  workerFile: fileURLToPath(new URL("../../helpers/callLogBudgetWorker.mjs", import.meta.url)),
  execArgv: [],
});
test.after(() => closeCallLogArtifactWriter());

function artifact(id: string, bodyChars: number): CallLogArtifact {
  return {
    schemaVersion: 5,
    summary: {
      id,
      timestamp: "2026-10-14T20:00:00.000Z",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "fixture",
      requestedModel: null,
      provider: "fixture",
      account: "fixture",
      connectionId: null,
      duration: 1,
      tokens: {
        in: 1,
        out: 1,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai",
      targetFormat: "openai",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { content: "x".repeat(bodyChars) },
    responseBody: { content: "answer" },
    error: null,
  };
}

test("a single oversized job is rejected before cloning it to the log worker", async () => {
  assert.equal(await writeCallArtifactAsync(artifact("oversized", 8 * 1024 * 1024)), null);
  assert.ok(await writeCallArtifactAsync(artifact("after-oversized", 16)));
});

test("pending log payloads exhaust a byte budget before the 128-job count limit", async () => {
  const writes = Array.from({ length: 12 }, (_, i) =>
    writeCallArtifactAsync(artifact(`backlog-${i}`, 2_500_000))
  );
  const results = await Promise.all(writes);
  assert.ok(
    results.some((result) => result === null),
    "a 60MB backlog must not all be retained"
  );
  assert.ok(
    results.some((result) => result !== null),
    "jobs within budget still write normally"
  );
  // After acknowledgements, the same load can be accepted again: stale byte
  // reservations must not permanently disable detailed logging.
  for (let i = 0; i < 8; i++) {
    assert.ok(await writeCallArtifactAsync(artifact(`drained-${i}`, 2_500_000)));
  }
});

test("worker failure releases both active and queued byte reservations", async () => {
  const writes = [
    writeCallArtifactAsync(artifact("crash", 2_500_000)),
    writeCallArtifactAsync(artifact("queued-a", 2_500_000)),
    writeCallArtifactAsync(artifact("queued-b", 2_500_000)),
  ];
  assert.deepEqual(await Promise.all(writes), [null, null, null]);
  for (let i = 0; i < 8; i++) {
    assert.ok(await writeCallArtifactAsync(artifact(`recovered-${i}`, 2_500_000)));
  }
});
