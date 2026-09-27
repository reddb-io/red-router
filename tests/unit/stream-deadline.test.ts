import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutorClientHeaders } from "../../open-sse/handlers/chatCore/executorClientHeaders.ts";
import {
  getDeadlineController,
  releaseDeadlineController,
  withDeadlineSignal,
  withEarlyStreamKeepalive,
  OPENAI_CHAT_ERROR_FRAME,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";
import { buildClientRawRequest } from "../../src/sse/handlers/chat/clientRawRequest.ts";

test("deadline signal follows the route request and survives a header-preserving rebuild", async () => {
  const original = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test" }),
  });
  const { wrappedReq, deadlineController } = withDeadlineSignal(original);
  const rebuilt = { headers: new Headers(wrappedReq.headers) };

  assert.equal(getDeadlineController(rebuilt), deadlineController);
  assert.equal(await wrappedReq.text(), JSON.stringify({ model: "test" }));
  deadlineController.abort();
  assert.equal(wrappedReq.signal.aborted, true);

  releaseDeadlineController(deadlineController);
  assert.equal(getDeadlineController(rebuilt), null);
});

test("deadline wrapping accepts a Next-style request without native Request private state", async () => {
  const original = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "test" }),
  });
  const nextStyleRequest = {
    url: original.url,
    method: original.method,
    headers: original.headers,
    body: original.body,
    signal: original.signal,
  } as Request;

  const { wrappedReq, deadlineController } = withDeadlineSignal(nextStyleRequest);
  assert.equal(wrappedReq.url, original.url);
  assert.equal(await wrappedReq.text(), JSON.stringify({ model: "test" }));
  deadlineController.abort();
  assert.equal(wrappedReq.signal.aborted, true);
  releaseDeadlineController(deadlineController);
});

test("deadline routing token is absent from logs and executor headers", () => {
  const request = new Request("http://localhost/v1/chat/completions", {
    headers: { "x-deadline-token": "private-token", "x-user-header": "allowed" },
  });
  const raw = buildClientRawRequest(request, { model: "test" });
  const executor = buildExecutorClientHeaders(request.headers);

  assert.equal(raw.headers["x-deadline-token"], undefined);
  assert.equal(executor?.["x-deadline-token"], undefined);
  assert.equal(executor?.["x-user-header"], "allowed");
});

test("slow-path deadline aborts the route and emits a sanitized error frame", async () => {
  const request = new Request("http://localhost/v1/chat/completions");
  const { wrappedReq, deadlineController } = withDeadlineSignal(request);
  const pending = new Promise<Response>((resolve) => {
    wrappedReq.signal.addEventListener("abort", () => resolve(new Response(null, { status: 504 })));
  });
  const response = await withEarlyStreamKeepalive(pending, {
    thresholdMs: 1,
    signal: wrappedReq.signal,
    deadlineController,
    slowPathDeadlineMs: 30,
    errorFrame: OPENAI_CHAT_ERROR_FRAME,
  });

  const body = await response.text();
  assert.equal(wrappedReq.signal.aborted, true);
  assert.match(body, /stream_error/);
  assert.equal(getDeadlineController({ headers: wrappedReq.headers }), null);
});
