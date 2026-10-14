import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-bridge-cleanup-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const store = await import("../../../src/lib/db/responsesContinuationStore.ts");
const { saveCallLog, closeCallLogSaves } = await import("../../../src/lib/usage/callLogs.ts");
const { closeCallLogArtifactWriter } =
  await import("../../../src/lib/usage/callLogArtifactWriter.ts");

// Simulate a saturated/unavailable worker. The call-log row still persists,
// with missing detail, but must not leave the full conversation in the bridge.
await closeCallLogArtifactWriter(0);
test.after(async () => {
  await closeCallLogSaves();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function save(responseId: string) {
  return saveCallLog({
    responseId,
    apiKeyId: "bridge-tenant",
    status: 200,
    method: "POST",
    path: "/v1/responses",
    model: "fixture",
    provider: "fixture",
    pipelinePayloads: {
      clientRawRequest: { body: { input: [{ role: "user", content: "Full conversation" }] } },
      clientResponse: { id: responseId, output: [{ type: "message", content: "Exact answer" }] },
    },
  });
}

test("missing artifacts release the temporary conversation after the save completes", async () => {
  const saving = save("resp_missing_artifact");
  assert.ok(store.resolvePreviousResponseState("resp_missing_artifact", "bridge-tenant"));
  await saving;
  assert.equal(store.resolvePreviousResponseState("resp_missing_artifact", "bridge-tenant"), null);
});

test("failed database inserts also release the temporary conversation", async () => {
  const db = core.getDbInstance();
  db.exec(`CREATE TEMP TRIGGER reject_bridge_log BEFORE INSERT ON call_logs
    BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
  try {
    const saving = save("resp_failed_insert");
    assert.ok(store.resolvePreviousResponseState("resp_failed_insert", "bridge-tenant"));
    await saving;
    assert.equal(store.resolvePreviousResponseState("resp_failed_insert", "bridge-tenant"), null);
  } finally {
    db.exec("DROP TRIGGER reject_bridge_log");
    store.clearPendingContinuationState("resp_failed_insert");
    store.clearPendingContinuationState("resp_missing_artifact");
  }
});
