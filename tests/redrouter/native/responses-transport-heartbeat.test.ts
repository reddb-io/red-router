import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENAI_RESPONSES_KEEPALIVE_FRAME,
  createSseHeartbeatTransform,
  HEARTBEAT_SHAPES,
} from "../../../open-sse/utils/sseHeartbeat.ts";
import {
  withEarlyStreamKeepalive,
  OPENAI_RESPONSES_ERROR_FRAME,
} from "../../../open-sse/utils/earlyStreamKeepalive.ts";
import { buildSyntheticResponsesFailedEvent } from "../../../open-sse/utils/responsesSequence.ts";
import { synthResponsesFailure } from "../../../open-sse/utils/diagnostics.ts";
import { buildStreamErrorChunks } from "../../../open-sse/utils/streamHandler.ts";

const wire =
  'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":{"id":"resp-real"}}\n\nevent: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"id":"resp-real","status":"completed","output":[]}}\n\n';
const dataEvents = (text: string) =>
  [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));

test("synthesized failures are decodable and retain an upstream response ID when available", () => {
  const event = buildSyntheticResponsesFailedEvent({ id: null, status: "failed" });
  assert.equal(typeof (event.response as { id: string }).id, "string");
  assert.equal(
    (
      buildSyntheticResponsesFailedEvent({ id: "real", status: "failed" }).response as {
        id: string;
      }
    ).id,
    "real"
  );
  for (const frame of [
    synthResponsesFailure("no_terminal"),
    new TextDecoder().decode(buildStreamErrorChunks("failed", 502, "openai-responses")),
  ]) {
    const failure = dataEvents(frame)[0];
    assert.equal(failure.type, "response.failed");
    assert.equal(typeof failure.response.id, "string");
    assert.equal(typeof failure.sequence_number, "number");
  }
});

test("slow Responses startup keeps transport alive without inventing response lifecycle events", async () => {
  const provider = new Promise<Response>((resolve) =>
    setTimeout(
      () => resolve(new Response(wire, { headers: { "content-type": "text/event-stream" } })),
      100
    )
  );
  const response = await withEarlyStreamKeepalive(provider, {
    thresholdMs: 5,
    intervalMs: 10,
    startupFrame: OPENAI_RESPONSES_KEEPALIVE_FRAME,
    applicationKeepalive: { frame: OPENAI_RESPONSES_KEEPALIVE_FRAME, intervalMs: 15 },
    errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
  });
  const body = await response.text();
  assert.match(body, /: keepalive/);
  assert.deepEqual(dataEvents(body), dataEvents(wire));
  assert.equal(dataEvents(body)[0].response.id, "resp-real");
});

test("midstream heartbeat remains decoder-neutral even when generic SSE comments are disabled", async () => {
  const previous = process.env.OMNIROUTE_SSE_COMMENTS;
  process.env.OMNIROUTE_SSE_COMMENTS = "off";
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(wire));
          controller.close();
        }, 50);
      },
    });
    const body = await new Response(
      stream.pipeThrough(
        createSseHeartbeatTransform({
          intervalMs: 5,
          shape: HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS,
        })
      )
    ).text();
    assert.match(body, /: keepalive/);
    assert.deepEqual(dataEvents(body), dataEvents(wire));
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_SSE_COMMENTS;
    else process.env.OMNIROUTE_SSE_COMMENTS = previous;
  }
});
