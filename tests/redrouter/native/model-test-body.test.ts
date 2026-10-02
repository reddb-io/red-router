import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readModelTestBody,
  MODEL_TEST_BODY_MAX_BYTES,
} from "../../../src/lib/api/modelTestBody.ts";
import { awaitWithAbort } from "../../../src/shared/utils/awaitWithAbort.ts";

const encoder = new TextEncoder();
test("an SSE probe completes at DONE even when the provider keeps its socket open", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of [
        'data: {"choices":[{"delta":{"content":"pong"}}]}\r\n\r\n',
        "data: [DO",
        "NE]\r\n\r\n",
      ])
        controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      canceled = true;
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const result = await readModelTestBody(new Response(body), true, controller.signal);
    assert.ok(result.includes('"pong"'));
    assert.equal(controller.signal.aborted, false);
    assert.equal(canceled, true);
  } finally {
    clearTimeout(timer);
  }
});

test("partial SSE output still times out, cancels the reader and does not count as a completed test", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  const controller = new AbortController();
  const error = new DOMException("Model test deadline", "TimeoutError");
  const result = readModelTestBody(new Response(body), true, controller.signal);
  controller.abort(error);
  await assert.rejects(result, (cause: unknown) => cause === error);
  assert.equal(canceled, true, "a stalled cancel hook must not stall the diagnostic");
});

test("probe responses have a retained-body size bound", async () => {
  const response = new Response(new Uint8Array(MODEL_TEST_BODY_MAX_BYTES + 1));
  await assert.rejects(readModelTestBody(response, false), /diagnostic size limit/);
});

test("an abort bounds operations that ignore cancellation, including late rejection", async () => {
  const controller = new AbortController();
  let rejectLate: (error: Error) => void;
  const result = awaitWithAbort(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectLate = reject;
      }),
    controller.signal
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  rejectLate(new Error("Late upstream failure"));
  await Promise.resolve();
});
