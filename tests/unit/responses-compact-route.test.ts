import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-responses-compact-"));
process.env.DATA_DIR = dataDir;
after(async () => await cleanupTempDataDir(dataDir));

const route = await import("../../src/app/api/v1/responses/compact/route.ts");
const admission = await import("../../src/shared/middleware/chatBodyAdmission.ts");

test("compact route shares Responses preflight without allowing arbitrary origins", async () => {
  const response = await route.OPTIONS();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("compact route rejects malformed JSON and releases raw-body admission", async () => {
  const malformed = `{"input":"${"x".repeat(admission.CHAT_LARGE_BODY_BYTES)}`;
  assert.equal(admission.perConnectionAdmissionController.activeHeavy, 0);

  const response = await route.POST(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(malformed)),
      },
      body: malformed,
    })
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.doesNotMatch(await response.text(), /Body is unusable|stack|node:internal/);
  assert.equal(admission.perConnectionAdmissionController.activeHeavy, 0);
});

test("compact route rejects arrays before chat dispatch", async () => {
  const response = await route.POST(
    new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    })
  );
  assert.equal(response.status, 400);
  assert.equal(admission.perConnectionAdmissionController.activeHeavy, 0);
});
