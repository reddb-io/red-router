import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { createStructuredSSECollector } from "../../../open-sse/utils/streamPayloadCollector.ts";

const omission = {
  _omniroute_truncated: true,
  reason: "stream_summary_memory_limit_exceeded",
};

for (const [format, event] of [
  [FORMATS.OPENAI, { choices: [{ delta: { content: "x".repeat(1000) } }] }],
  [FORMATS.OPENAI, { choices: [{ delta: { reasoning_content: "x".repeat(1000) } }] }],
  [
    FORMATS.OPENAI,
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: "x".repeat(1000) } }] } },
      ],
    },
  ],
  [FORMATS.OPENAI_RESPONSES, { type: "response.output_text.delta", delta: "x".repeat(1000) }],
  [
    FORMATS.CLAUDE,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "x".repeat(1000) },
    },
  ],
  [FORMATS.GEMINI, { candidates: [{ content: { parts: [{ text: "x".repeat(1000) }] } }] }],
] as const) {
  test(`${format} live summaries stop retaining deltas after their own budget is exhausted`, () => {
    const collector = createStructuredSSECollector({ format, maxBytes: 0, maxSummaryBytes: 4096 });
    collector.push(event);
    assert.notDeepEqual(collector.getSummary(), omission);
    for (let i = 0; i < 100; i++) collector.push(event);
    assert.deepEqual(collector.getSummary(), omission);
    // A synthesized partial summary from a caller cannot turn missing history
    // back into a valid continuation or silently log truncated tool arguments.
    const built = collector.build({ output: [{ text: "partial" }] }, { includeEvents: false });
    assert.equal(built._truncated, true);
    assert.deepEqual(built.summary, omission);
    assert.equal(collector.getEvents().length, 0);
  });
}

test("small terminal Responses snapshots recover exact history after a long delta burst", () => {
  const collector = createStructuredSSECollector({
    format: FORMATS.OPENAI_RESPONSES,
    maxSummaryBytes: 4096,
  });
  collector.push({ type: "response.output_text.delta", delta: "x".repeat(4096) });
  assert.deepEqual(collector.getSummary(), omission);
  const response = {
    id: "resp_complete",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Exact answer" }] }],
  };
  collector.push({ event: "response.completed", data: { type: "response.completed", response } });
  const summary = collector.getSummary() as { id: string; output: unknown; status: string };
  assert.equal(summary.id, response.id);
  assert.equal(summary.status, response.status);
  assert.deepEqual(summary.output, response.output);
  assert.equal(collector.build(summary)._summaryTruncated, undefined);
});

test("event storage caps do not truncate an otherwise small live summary", () => {
  const collector = createStructuredSSECollector({ format: FORMATS.OPENAI, maxEvents: 1 });
  for (const content of ["first ", "second ", "last"]) {
    collector.push({ choices: [{ delta: { content } }] });
  }
  const summary = collector.getSummary() as { choices: Array<{ message: { content: string } }> };
  assert.equal(summary.choices[0].message.content, "first second last");
});

test("empty terminal output preserves the complete text reconstructed from deltas", () => {
  const collector = createStructuredSSECollector({ format: FORMATS.OPENAI_RESPONSES });
  collector.push({ type: "response.output_text.delta", delta: "Exact answer" });
  collector.push({
    type: "response.completed",
    response: { id: "resp_empty_snapshot", status: "completed", output: [] },
  });
  const summary = collector.getSummary() as {
    output: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(summary.output[0].content[0].text, "Exact answer");
});

test("a long stream releases retained response text under a full garbage collection", () => {
  execFileSync(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx/esm",
      fileURLToPath(new URL("../../helpers/streamSummaryMemoryProbe.ts", import.meta.url)),
    ],
    { timeout: 30_000, stdio: "pipe" }
  );
});
