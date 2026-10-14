import assert from "node:assert/strict";
import { createStructuredSSECollector } from "../../open-sse/utils/streamPayloadCollector.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "memory probe requires --expose-gc");
const collector = createStructuredSSECollector({
  format: "openai",
  maxBytes: 0,
  maxSummaryBytes: 16 * 1024,
});
gc();
const before = process.memoryUsage().heapUsed;
for (let index = 0; index < 256; index++) {
  // Materialize distinct strings, so V8 ropes/deduplication cannot disguise
  // retained response text. The baseline retains over 20MB after a full GC.
  const content = new Array(4096).fill(index.toString(16).padStart(16, "x")).join("");
  collector.push({ choices: [{ delta: { content } }] });
}
gc();
const growth = process.memoryUsage().heapUsed - before;
assert.ok(growth < 2 * 1024 * 1024, `live summary retained ${growth} bytes beyond its budget`);
assert.deepEqual(collector.getSummary(), {
  _omniroute_truncated: true,
  reason: "stream_summary_memory_limit_exceeded",
});
