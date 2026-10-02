import assert from "node:assert/strict";
import test from "node:test";

import { buildErrorBody } from "../../../open-sse/utils/error.ts";
import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { createSSEStream } from "../../../open-sse/utils/stream.ts";
import { normalizeStreamFailurePayload } from "../../../open-sse/utils/streamErrorFormat.ts";

test("a billing failure keeps its classification through two Router SSE hops", async () => {
  const encoder = new TextEncoder();
  const statuses: number[][] = [[], []];
  const upstream = buildErrorBody(402, "This request requires more credits, or fewer max_tokens.");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(upstream)}\n\n`));
      controller.close();
    },
  });
  let stream = source;
  for (let hop = 0; hop < 2; hop++) {
    stream = stream.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.OPENAI,
        clientResponseFormat: FORMATS.OPENAI,
        onFailure: (failure) => {
          statuses[hop].push(failure.status);
          return true;
        },
      })
    );
  }
  const output = await new Response(stream).text();
  const errors = output
    .split("\n")
    .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(5)))
    .filter((payload) => payload.error);
  assert.deepEqual(statuses, [[402], [402]]);
  assert.equal(errors.length, 1);
  assert.equal(normalizeStreamFailurePayload(errors[0])?.status, 402);
  assert.match(errors[0].error.message, /more credits/);
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
