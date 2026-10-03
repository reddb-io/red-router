import assert from "node:assert/strict";
import { test } from "node:test";
import { createCreditsExtractionTransform } from "../../../open-sse/executors/antigravity/streamingPassthrough.ts";
import { createSSEStream } from "../../../open-sse/utils/stream.ts";

const encoder = new TextEncoder();
const chunk = (content: string, finish: string | null = null) =>
  encoder.encode(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
  );

test("generic SSE and Antigravity stop accepting oversized chunks until a slow client reads", async () => {
  for (const stream of [
    createCreditsExtractionTransform("fixture-account", () => {}),
    createSSEStream({
      mode: "passthrough",
      targetFormat: "openai",
      sourceFormat: "openai",
      streamBufferBytes: 16 * 1024,
    }),
  ]) {
    const writer = stream.writable.getWriter();
    await writer.write(chunk("x".repeat(64 * 1024)));
    let secondAccepted = false;
    const pending = writer.write(chunk("second")).then(() => {
      secondAccepted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const acceptedWithoutReader = secondAccepted;
    // Always drain the stream before asserting, including with a broken budget.
    const reader = stream.readable.getReader();
    const draining = (async () => {
      while (!(await reader.read()).done) {}
    })();
    await pending;
    await writer.write(chunk("", "stop"));
    await writer.close();
    await draining;
    reader.releaseLock();
    writer.releaseLock();
    assert.equal(
      acceptedWithoutReader,
      false,
      "64KiB exhausts a 16KiB byte budget, so a second write waits for the downstream reader"
    );
  }
});
