import assert from "node:assert/strict";
import test from "node:test";

import { buildErrorBody } from "../../../open-sse/utils/error.ts";
import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { createSSEStream } from "../../../open-sse/utils/stream.ts";
import {
  normalizeStreamFailurePayload,
  projectCompletedStreamError,
  type StreamFailurePayload,
} from "../../../open-sse/utils/streamErrorFormat.ts";

test("a billing failure keeps its classification through two Router SSE hops", async () => {
  const encoder = new TextEncoder();
  const statuses: number[][] = [[], []];
  const upstream = buildErrorBody(402, "This request requires more credits, or fewer max_tokens.");
  let payload = upstream;
  for (let hop = 0; hop < 2; hop++) {
    let failure: StreamFailurePayload | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        controller.close();
      },
    });
    const stream = source.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.OPENAI,
        clientResponseFormat: FORMATS.OPENAI,
        onFailure: (value) => {
          failure = value;
          statuses[hop].push(value.status);
          return true;
        },
      })
    );
    // The stream's failure boundary rejects; the Router completion seam emits
    // the canonical projected error to the next peer after recording the failure.
    await assert.rejects(new Response(stream).text(), /more credits/);
    assert.ok(failure);
    payload = { error: projectCompletedStreamError(failure) as typeof upstream.error };
  }
  assert.deepEqual(statuses, [[402], [402]]);
  assert.equal(normalizeStreamFailurePayload(payload)?.status, 402);
  assert.match(payload.error.message, /more credits/);
});

test("numeric HTTP error codes retain their status without interpreting application codes", () => {
  for (const status of [400, 401, 402, 403, 429, 500, 503, 504]) {
    for (const code of [status, String(status)]) {
      assert.equal(
        normalizeStreamFailurePayload({ error: { code, message: "Upstream failure" } })?.status,
        status
      );
    }
  }
  for (const code of [200, 399, 600, 1001, "1001", "402oops"]) {
    assert.equal(
      normalizeStreamFailurePayload({ error: { code, message: "Upstream failure" } })?.status,
      502
    );
  }
  assert.equal(
    normalizeStreamFailurePayload({ error: { code: "402", status_code: 403 } })?.status,
    403
  );
});
