import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import { IFlowExecutor } from "../../open-sse/executors/iflow.ts";
import {
  buildIFlowSignedHeaders,
  createIFlowSignature,
  IFLOW_USER_AGENT,
} from "../../open-sse/services/iflowSignature.ts";

test("iFlow probe and executor use the same credential-bound HMAC contract", () => {
  const credential = "test-iflow-token";
  const executorHeaders = new IFlowExecutor().buildHeaders({ accessToken: credential }, false);
  const probeHeaders = buildIFlowSignedHeaders(credential);

  for (const headers of [executorHeaders, probeHeaders]) {
    const sessionId = headers["session-id"];
    const timestamp = headers["x-iflow-timestamp"];
    assert.match(sessionId, /^session-[0-9a-f-]+$/);
    assert.match(timestamp, /^\d+$/);
    assert.equal(
      headers["x-iflow-signature"],
      createHmac("sha256", credential)
        .update(`${IFLOW_USER_AGENT}:${sessionId}:${timestamp}`)
        .digest("hex")
    );
  }

  assert.equal(executorHeaders.Authorization, `Bearer ${credential}`);
  assert.equal(createIFlowSignature(IFLOW_USER_AGENT, "session-test", 1, ""), "");
});
