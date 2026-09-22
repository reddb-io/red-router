// Standalone Responses transformer: response.completed must carry usage even when
// the upstream sends it on a trailing chunk with an empty choices array.
import { describe, it, expect } from "vitest";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";

async function run(chunks) {
  const encoder = new TextEncoder();
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream({ start(c) { c.enqueue(encoder.encode(body)); c.close(); } });
  const text = await new Response(stream.pipeThrough(createResponsesApiTransformStream(null))).text();
  return text.split("\n\n").map((b) => b.match(/^data: (.+)$/m)?.[1]).filter((d) => d && d !== "[DONE]").map(JSON.parse);
}

const completedOf = (events) => events.filter((e) => e.type === "response.completed");

describe("responsesTransformer usage", () => {
  it("attaches trailing-chunk usage to a single response.completed", async () => {
    const events = await run([
      { id: "a", choices: [{ index: 0, delta: { content: "hi" } }] },
      { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "a", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } } },
    ]);
    const completed = completedOf(events);
    expect(completed).toHaveLength(1);
    expect(completed[0].response.usage).toEqual({
      input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 },
    });
  });

  it("still completes when the upstream never reports usage", async () => {
    const events = await run([
      { id: "b", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);
    const completed = completedOf(events);
    expect(completed).toHaveLength(1);
    expect(completed[0].response.usage).toBeUndefined();
  });
});
