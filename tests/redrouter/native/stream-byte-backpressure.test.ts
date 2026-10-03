import assert from "node:assert/strict";
import { test } from "node:test";
import { createCreditsExtractionTransform } from "../../../open-sse/executors/antigravity/streamingPassthrough.ts";
import { createSSEStream } from "../../../open-sse/utils/stream.ts";

test("generic SSE and Antigravity writes apply byte backpressure to large chunks", async () => {
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
    const chunk = new Uint8Array(64 * 1024);
    const pending = writer.write(chunk).catch(() => {});
    assert.ok(
      writer.desiredSize! < 0,
      "64KiB must exhaust a 16KiB budget; counting chunks incorrectly leaves it positive"
    );
    // Drain and close instead of leaving a blocked write and its timers alive.
    const reader = stream.readable.getReader();
    const draining = (async () => {
      while (!(await reader.read()).done) {}
    })();
    await pending;
    await writer.close();
    await draining;
    reader.releaseLock();
    writer.releaseLock();
  }
});
