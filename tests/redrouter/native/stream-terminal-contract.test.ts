import assert from "node:assert/strict";
import test from "node:test";

import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { initState, translateResponse } from "../../../open-sse/translator/index.ts";
import { openaiToOpenAIResponsesResponse } from "../../../open-sse/translator/response/openai-responses.ts";
import { createResponsesApiTransformStream } from "../../../open-sse/transformer/responsesTransformer.ts";
import { createSSEStream } from "../../../open-sse/utils/stream.ts";
import {
  createStreamTerminalTracker,
  createTrailingUsageDeadline,
  withStreamCleanup,
} from "../../../open-sse/utils/streamTerminal.ts";

const encoder = new TextEncoder();
type Payload = Record<string, unknown>;
type ResponsesPayload = {
  id: string;
  status: string;
  error: { message: string; code?: string } | null;
  incomplete_details?: unknown;
  usage?: { input_tokens: number; output_tokens: number };
  output: Array<{ status: string; type: string }>;
};
type TranslatorEvent = { event: string; data: Payload };

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const chat = (delta: Payload, finishReason: string | null = null, index = 0) => ({
  id: "chatcmpl-terminal",
  model: "test-model",
  object: "chat.completion.chunk",
  choices: [{ index, delta, finish_reason: finishReason }],
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const payloads = (text: string): Payload[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(5)) as Payload);
const source = (frames: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of frames) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
const collect = (
  input: ReadableStream<Uint8Array>,
  transform: TransformStream<Uint8Array, Uint8Array>
) => new Response(input.pipeThrough(transform)).text();
const liveEvents = (chunks: unknown[]): TranslatorEvent[] => {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  return chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state) || []);
};

for (const delta of [
  { content: "Partial answer" },
  {
    tool_calls: [
      {
        index: 0,
        id: "call_partial",
        type: "function",
        function: { name: "lookup", arguments: '{"query":' },
      },
    ],
  },
]) {
  const name = "content" in delta ? "text" : "tool arguments";
  test(`live Responses EOF preserves partial ${name} and emits failed`, () => {
    const events = liveEvents([chat(delta), null]);
    assert.ok(events.some((event) => event.event.endsWith(".delta")));
    assert.equal(events.filter((event) => event.event === "response.completed").length, 0);
    const failures = events.filter((event) => event.event === "response.failed");
    assert.equal(failures.length, 1);
    const response = failures[0].data.response as ResponsesPayload;
    assert.equal(response.status, "failed");
    assert.ok(response.output.length > 0);
    assert.ok(response.output.every((item) => item.status === "incomplete"));
    assert.ok(!response.error?.message.includes("at /"));
    const created = events.find((event) => event.event === "response.created")!;
    assert.equal(response.id, (created.data.response as ResponsesPayload).id);
  });

  test(`legacy Responses EOF preserves partial ${name} and emits failed`, async () => {
    const text = await collect(
      source([frame(chat(delta))]),
      createResponsesApiTransformStream(null, 60_000)
    );
    const events = payloads(text);
    assert.ok(events.some((event) => String(event.type).endsWith(".delta")));
    assert.ok(!text.includes("event: response.completed"));
    assert.ok(!text.includes("data: [DONE]"));
    const failures = events.filter((event) => event.type === "response.failed");
    assert.equal(failures.length, 1);
    const response = failures[0].response as ResponsesPayload;
    assert.equal(response.status, "failed");
    assert.ok(response.output.every((item) => item.status === "incomplete"));
    assert.ok(!response.error?.message.includes("at /"));
  });
}

for (const mode of ["passthrough", "translate"] as const) {
  test(`${mode} EOF is an accounted failure rather than a synthetic stop`, async () => {
    const completed: Array<{ status: number; interrupted?: boolean; usage: unknown }> = [];
    const failures: Array<{ status: number }> = [];
    const text = await collect(
      source([frame(chat({ content: "Partial answer" }))]),
      createSSEStream({
        mode,
        targetFormat: FORMATS.OPENAI,
        sourceFormat: mode === "translate" ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI,
        clientResponseFormat: FORMATS.OPENAI,
        body: { model: "test-model", messages: [{ role: "user", content: "Please answer" }] },
        onComplete: (result) => {
          completed.push(result);
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      })
    );
    assert.ok(text.includes("Partial answer"));
    assert.ok(!text.includes('"finish_reason":"stop"'));
    assert.ok(!text.includes('"finish_reason":"tool_calls"'));
    assert.ok(!text.includes("event: response.completed"));
    assert.ok(payloads(text).some((event) => event.error || event.type === "response.failed"));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 502);
    assert.equal(completed[0].interrupted, true);
    assert.ok(completed[0].usage);
    assert.equal(failures.length, 1);
  });
}

for (const finish of [frame(chat({}, "stop")).trimEnd(), "data: [DONE]"]) {
  test(`OpenAI terminal without a final newline is accepted: ${finish.slice(0, 30)}`, async () => {
    const text = await collect(
      source([frame(chat({ content: "Complete answer" })), finish]),
      createSSEStream({
        mode: "translate",
        targetFormat: FORMATS.OPENAI,
        sourceFormat: FORMATS.OPENAI_RESPONSES,
      })
    );
    assert.equal(payloads(text).filter((event) => event.type === "response.completed").length, 1);
    assert.ok(!text.includes("response.failed"));
  });
}

test("usage arriving after finish_reason reaches the final Responses response", async () => {
  const text = await collect(
    source([
      frame(chat({ content: "Answer" })),
      frame(chat({}, "stop")),
      frame({ choices: [], usage: { prompt_tokens: 55, completion_tokens: 11, total_tokens: 66 } }),
      "data: [DONE]\n\n",
    ]),
    createSSEStream({
      mode: "translate",
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    })
  );
  const completed = payloads(text).filter((event) => event.type === "response.completed");
  assert.equal(completed.length, 1);
  const response = completed[0].response as ResponsesPayload;
  assert.equal(response.usage?.input_tokens, 55);
  assert.equal(response.usage?.output_tokens, 11);
});

for (const kind of ["legacy", "live"] as const) {
  test(
    `${kind} stops waiting for optional usage only after generation has finished`,
    { timeout: 2000 },
    async () => {
      let cancelled = false;
      const completed: Array<{ status: number }> = [];
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame(chat({ content: "Complete answer" }))));
          controller.enqueue(encoder.encode(frame(chat({}, "stop"))));
        },
        cancel() {
          cancelled = true;
        },
      });
      const transform =
        kind === "legacy"
          ? createResponsesApiTransformStream(null, 60_000, { trailingUsageTimeoutMs: 20 })
          : createSSEStream({
              mode: "translate",
              targetFormat: FORMATS.OPENAI,
              sourceFormat: FORMATS.OPENAI_RESPONSES,
              trailingUsageTimeoutMs: 20,
              onComplete: (result) => {
                completed.push(result);
              },
            });
      const text = await collect(input, transform);
      assert.equal(payloads(text).filter((event) => event.type === "response.completed").length, 1);
      assert.ok(!text.includes("response.failed"));
      await delay(10);
      assert.equal(cancelled, true);
      if (kind === "live")
        assert.deepEqual(
          completed.map((result) => result.status),
          [200]
        );
    }
  );

  test(
    `${kind} does not apply the trailer deadline to active generation`,
    { timeout: 2000 },
    async () => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const input = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(encoder.encode(frame(chat({ content: "First" }))));
        },
        cancel() {
          cancelled = true;
        },
      });
      const transform =
        kind === "legacy"
          ? createResponsesApiTransformStream(null, 60_000, { trailingUsageTimeoutMs: 20 })
          : createSSEStream({
              mode: "translate",
              targetFormat: FORMATS.OPENAI,
              sourceFormat: FORMATS.OPENAI_RESPONSES,
              trailingUsageTimeoutMs: 20,
            });
      const reading = collect(input, transform);
      await delay(80);
      assert.equal(cancelled, false);
      controller!.enqueue(encoder.encode(": heartbeat\n\n"));
      controller!.enqueue(encoder.encode(frame(chat({ content: "Second" }))));
      controller!.enqueue(encoder.encode(frame(chat({}, "stop"))));
      controller!.close();
      const text = await reading;
      assert.ok(text.includes("First"));
      assert.ok(text.includes("Second"));
      assert.ok(!text.includes("response.failed"));
    }
  );
}

for (const [stopReason, terminal] of [
  ["pause_turn", "response.incomplete"],
  ["end_turn", "response.completed"],
  ["tool_use", "response.completed"],
]) {
  test(`Claude ${stopReason} retains its Responses terminal meaning`, () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events: TranslatorEvent[] = [];
    for (const chunk of [
      {
        type: "message_start",
        message: { id: "msg-pause", model: "claude", usage: { input_tokens: 12 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Result" } },
      { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
      null,
    ])
      events.push(
        ...(translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, chunk, state) || [])
      );
    const terminals = events.filter((event) =>
      ["response.completed", "response.incomplete", "response.failed"].includes(event.event)
    );
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].event, terminal);
    if (stopReason === "pause_turn") {
      const response = terminals[0].data.response as ResponsesPayload;
      assert.equal(response.status, "incomplete");
      assert.equal(response.incomplete_details, null);
    }
  });
}

test("one finished OpenAI/Gemini choice cannot stop another active choice", () => {
  const openai = createStreamTerminalTracker(FORMATS.OPENAI, 2);
  assert.equal(openai(chat({ content: "First" }, null, 0)), false);
  assert.equal(openai(chat({}, "stop", 0)), false);
  assert.equal(openai(chat({ content: "Second" }, null, 1)), false);
  assert.equal(openai(chat({}, "stop", 1)), true);
  const gemini = createStreamTerminalTracker(FORMATS.GEMINI, 2);
  assert.equal(gemini({ candidates: [{ index: 0, finishReason: "STOP" }] }), false);
  assert.equal(gemini({ candidates: [{ index: 1, finishReason: "MAX_TOKENS" }] }), true);
});

for (const kind of ["legacy", "live"] as const) {
  test(
    `${kind} waits for both requested choices even when usage is already present`,
    { timeout: 2000 },
    async () => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const input = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(
            encoder.encode(
              frame({
                ...chat({ content: "First" }),
                usage: { prompt_tokens: 4, completion_tokens: 1 },
              })
            )
          );
          value.enqueue(encoder.encode(frame(chat({}, "stop", 0))));
        },
        cancel() {
          cancelled = true;
        },
      });
      const transform =
        kind === "legacy"
          ? createResponsesApiTransformStream(null, 60_000, {
              trailingUsageTimeoutMs: 20,
              expectedChoices: 2,
            })
          : createSSEStream({
              mode: "translate",
              targetFormat: FORMATS.OPENAI,
              sourceFormat: FORMATS.OPENAI_RESPONSES,
              body: { n: 2 },
              trailingUsageTimeoutMs: 20,
            });
      const reading = collect(input, transform);
      await delay(80);
      assert.equal(cancelled, false);
      controller!.enqueue(encoder.encode(frame(chat({ content: "Second" }, null, 1))));
      controller!.enqueue(encoder.encode(frame(chat({}, "stop", 1))));
      controller!.close();
      const text = await reading;
      assert.ok(text.includes("Second"));
      assert.equal(payloads(text).filter((event) => event.type === "response.completed").length, 1);
    }
  );
}

test("post-finish heartbeats do not extend the one-shot usage deadline", (t) => {
  const context = t.mock;
  context.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const deadline = createTrailingUsageDeadline(100);
    deadline.arm(() => {
      calls += 1;
    });
    context.timers.tick(80);
    deadline.arm(() => {
      calls += 1;
    });
    context.timers.tick(20);
    assert.equal(calls, 1);
    deadline.clear();
    context.timers.tick(500);
    assert.equal(calls, 1);
  } finally {
    context.timers.reset();
  }
});

test("natural EOF shares an in-progress deadline flush and records completion once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = 0;
  let failed = 0;
  const stream = createSSEStream({
    mode: "translate",
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    trailingUsageTimeoutMs: 20,
    onComplete: () => {
      completed += 1;
    },
    onFailure: () => {
      failed += 1;
    },
  });
  const reading = new Response(stream.readable).text();
  const writer = stream.writable.getWriter();
  await writer.write(encoder.encode(frame(chat({ content: "Answer" }))));
  await writer.write(encoder.encode(frame(chat({}, "stop"))));
  // The timer begins async finalization, then EOF arrives before its await resumes.
  t.mock.timers.tick(20);
  await writer.close().catch(() => {}); // Termination can reject the source writer.
  const text = await reading;
  assert.equal(payloads(text).filter((event) => event.type === "response.completed").length, 1);
  assert.equal(text.split("data: [DONE]").length - 1, 1);
  assert.equal(completed, 1);
  assert.equal(failed, 0);
});

test("cancel clears a pending usage deadline without emitting a late failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = 0;
  let failed = 0;
  const stream = createSSEStream({
    mode: "translate",
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    trailingUsageTimeoutMs: 20,
    onComplete: () => {
      completed += 1;
    },
    onFailure: () => {
      failed += 1;
    },
  });
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const first = reader.read();
  await writer.write(encoder.encode(frame(chat({ content: "Answer" }))));
  await first;
  await writer.write(encoder.encode(frame(chat({}, "stop"))));
  await reader.cancel("client cancelled");
  t.mock.timers.tick(100);
  assert.equal(completed, 0);
  assert.equal(failed, 0);
});

test(
  "readable cancellation propagates to an idle source and clears lifecycle timers",
  { timeout: 2000 },
  async () => {
    let cancelled: unknown;
    let cleaned = 0;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const stream = withStreamCleanup(new TransformStream<Uint8Array, Uint8Array>(), () => {
      cleaned += 1;
    });
    const reader = input.pipeThrough(stream).getReader();
    await reader.read();
    await reader.cancel("client cancelled");
    await delay(10);
    assert.ok(cleaned > 0);
    assert.equal(cancelled, "client cancelled");
  }
);

test("client cancellation and writable abort do not count as upstream failures", async () => {
  for (const boundary of ["readable", "writable"] as const) {
    let failures = 0;
    let completed = 0;
    const stream = createSSEStream({
      mode: "passthrough",
      sourceFormat: FORMATS.OPENAI,
      clientResponseFormat: FORMATS.OPENAI,
      onFailure: () => {
        failures += 1;
      },
      onComplete: () => {
        completed += 1;
      },
    });
    if (boundary === "readable") await stream.readable.cancel("client cancelled");
    else await stream.writable.abort("client cancelled");
    await delay(10);
    assert.equal(failures, 0);
    assert.equal(completed, 0);
  }
});
