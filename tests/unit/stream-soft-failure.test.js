// A failure that arrives with HTTP 200 (an error event, `choices: null`, a
// role-only stream, a finish_reason that means failure) becomes an error result
// before the client sees the 200, so accounts and combos can still fall back.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => {}),
}));

const { classifyStreamEvent, createStreamProbe, nonStreamFailure } = await import("../../open-sse/handlers/chatCore/streamProbe.js");
const { prepareStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamResponse.js");
const { createDisconnectAwareStream } = await import("../../open-sse/utils/streamHandler.js");
const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sse = (obj, event = null) => `${event ? `event: ${event}\n` : ""}data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`;
const kind = (obj, event) => classifyStreamEvent({ event, data: typeof obj === "string" ? obj : JSON.stringify(obj) }).kind;

function sseResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// A body the test feeds by hand, to hold the upstream silent.
function manualResponse() {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

const prepare = (response, extra = {}) => prepareStreamingResponse({
  initialResult: { response }, executor: {}, targetFormat: "openai", provider: "p", model: "m", maxRetries: 1, ...extra,
});

afterEach(() => vi.useRealTimers());

describe("classifyStreamEvent", () => {
  it("OpenAI: role-only and empty choices are pending; content, reasoning, tools and stops answer", () => {
    expect(kind({ choices: [{ delta: { role: "assistant" } }] })).toBe("pending");
    expect(kind({ choices: null })).toBe("pending");
    expect(kind({ choices: [] })).toBe("pending");
    expect(kind({ choices: [{ delta: { content: "hi" } }] })).toBe("answer");
    expect(kind({ choices: [{ delta: { reasoning_content: "hm" } }] })).toBe("answer");
    expect(kind({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe("answer");
    expect(kind({ choices: [{ delta: {}, finish_reason: "stop" }] })).toBe("answer");
  });

  it("GLM's context-window finish_reason is a 400, finish_reason error a failure", () => {
    expect(classifyStreamEvent({ data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "model_context_window_exceeded" }] }) }))
      .toMatchObject({ kind: "error", statusCode: 400 });
    expect(kind({ choices: [{ delta: {}, finish_reason: "error" }] })).toBe("error");
  });

  it("maps in-band errors to a status that drives fallback", () => {
    expect(classifyStreamEvent({ data: JSON.stringify({ error: { message: "You exceeded your current quota" } }) })).toMatchObject({ kind: "error", statusCode: 429 });
    expect(classifyStreamEvent({ event: "error", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }))
      .toMatchObject({ kind: "error", statusCode: 503, message: "Overloaded" });
    expect(classifyStreamEvent({ data: JSON.stringify({ error: { code: 500, message: "internal" } }) })).toMatchObject({ statusCode: 500 });
    expect(classifyStreamEvent({ data: JSON.stringify({ error: "boom" }) })).toMatchObject({ kind: "error", statusCode: 502 });
  });

  it("Claude, Responses and Gemini preambles are pending; their content answers", () => {
    expect(kind({ type: "message_start", message: {} })).toBe("pending");
    expect(kind({ type: "ping" })).toBe("pending");
    expect(kind({ type: "content_block_start", content_block: { type: "text", text: "" } })).toBe("pending");
    expect(kind({ type: "content_block_start", content_block: { type: "tool_use", name: "x" } })).toBe("answer");
    expect(kind({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })).toBe("answer");
    expect(kind({ type: "response.created", response: {} })).toBe("pending");
    expect(kind({ type: "response.output_text.delta", delta: "hi" })).toBe("answer");
    expect(kind({ type: "response.failed", response: { error: { message: "nope" } } })).toBe("error");
    expect(kind({ candidates: [{ content: { parts: [] } }] })).toBe("pending");
    expect(kind({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBe("answer");
  });

  it("fails open on unknown shapes, non-JSON data and [DONE]", () => {
    expect(kind({ something: "else" })).toBe("answer");
    expect(kind("not json")).toBe("answer");
    expect(kind("[DONE]")).toBe("done");
  });

  it("the probe parses events split across chunks and skips comments", () => {
    const probe = createStreamProbe();
    expect(probe.push(": keepalive\n\n")).toEqual({ kind: "pending" });
    expect(probe.push('data: {"choices":[{"delta":{"con')).toEqual({ kind: "pending" });
    expect(probe.push('tent":"hi"}}]}\r\n\r\n')).toEqual({ kind: "answer" });
  });
});

describe("prepareStreamingResponse read-ahead", () => {
  it("turns an error event after a role chunk into an error result, without retrying", async () => {
    const execute = vi.fn();
    const result = await prepare(sseResponse([
      sse({ choices: [{ delta: { role: "assistant" } }] }),
      sse({ error: { message: "Rate limit reached for requests" } }),
    ]), { execute });
    expect(result.error).toMatchObject({ statusCode: 429, message: expect.stringContaining("Rate limit") });
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries a stream that ends after only preamble events, like an empty one", async () => {
    const execute = vi.fn(async () => ({ response: sseResponse([sse({ choices: [{ delta: { content: "ok" } }] })]) }));
    const result = await prepare(sseResponse([sse({ choices: null }), sse({ choices: [{ delta: { role: "assistant" } }] }), "data: [DONE]\n\n"]), { execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(await result.response.text()).toContain('"content":"ok"');
  });

  it("reports an exhausted preamble-only stream as ended without content", async () => {
    const execute = vi.fn(async () => ({ response: sseResponse([sse({ choices: [] })]) }));
    const result = await prepare(sseResponse([sse({ choices: [] })]), { execute });
    expect(result.error).toMatchObject({ statusCode: 502, message: "Upstream stream ended without any content" });
  });

  it("replays every byte it read ahead, in order", async () => {
    const chunks = [sse({ choices: [{ delta: { role: "assistant" } }] }), "data: {\"choices\":[{\"delta\":{\"content\":\"a", "\"}}]}\n\n", sse({ choices: [{ delta: { content: "b" } }] })];
    const result = await prepare(sseResponse(chunks), { execute: vi.fn() });
    expect(await result.response.text()).toBe(chunks.join(""));
  });

  it("releases a silent stream at the read-ahead deadline and keeps the pending read", async () => {
    vi.useFakeTimers();
    const upstream = manualResponse();
    upstream.push(sse({ choices: [{ delta: { role: "assistant" } }] }));
    const pending = prepare(upstream.response, { execute: vi.fn(), readAheadMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.response).toBeInstanceOf(Response);
    upstream.push(sse({ choices: [{ delta: { content: "late" } }] }));
    upstream.close();
    expect(await result.response.text()).toContain("late");
  });

  it("does not probe non-SSE bodies", async () => {
    const result = await prepare(sseResponse(["\x00\x01binary-frame"]), { execute: vi.fn() });
    expect(await result.response.text()).toBe("\x00\x01binary-frame");
  });
});

describe("nonStreamFailure", () => {
  it("flags error envelopes, missing choices and failing finish reasons", () => {
    expect(nonStreamFailure({ error: { message: "quota exceeded" } })).toMatchObject({ statusCode: 429 });
    expect(nonStreamFailure({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toMatchObject({ statusCode: 503 });
    expect(nonStreamFailure({ object: "chat.completion", choices: null })).toMatchObject({ statusCode: 502 });
    expect(nonStreamFailure({ choices: [{ message: { content: "" }, finish_reason: "model_context_window_exceeded" }] })).toMatchObject({ statusCode: 400 });
    expect(nonStreamFailure({ object: "response", status: "failed", error: { message: "bad" } })).toMatchObject({ message: "bad" });
  });

  it("passes answers, including empty stops and tool calls", () => {
    expect(nonStreamFailure({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] })).toBeNull();
    expect(nonStreamFailure({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })).toBeNull();
    expect(nonStreamFailure({ choices: [{ message: { content: null, tool_calls: [{ id: "t" }] }, finish_reason: "model_context_window_exceeded" }] })).toBeNull();
    expect(nonStreamFailure({ type: "message", content: [] })).toBeNull();
    expect(nonStreamFailure({ candidates: [] })).toBeNull();
  });
});

describe("SSE keepalive", () => {
  function silentPipe(keepaliveMs) {
    let ctrl;
    const readable = new ReadableStream({ start(c) { ctrl = c; } });
    const controller = { isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {} };
    const stream = createDisconnectAwareStream({ readable, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } }, controller, null, { keepaliveMs });
    return { reader: stream.getReader(), push: (t) => ctrl.enqueue(encoder.encode(t)) };
  }

  it("sends a comment while the upstream is silent, then the data", async () => {
    vi.useFakeTimers();
    const { reader, push } = silentPipe(15_000);
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(decoder.decode((await first).value)).toBe(": keepalive\n\n");
    const second = reader.read();
    push(sse({ choices: [{ delta: { content: "hi" } }] }));
    expect(decoder.decode((await second).value)).toContain("hi");
  });

  it("never splits an event: no keepalive after a partial one", async () => {
    vi.useFakeTimers();
    const { reader, push } = silentPipe(15_000);
    push("data: {\"partial\":");
    await reader.read();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(60_000);
    push("true}\n\n");
    expect(decoder.decode((await next).value)).toBe("true}\n\n");
  });
});

describe("usage when the client disconnects", () => {
  it("calls onTerminate on cancel", async () => {
    const onTerminate = vi.fn();
    const readable = new ReadableStream({ start() {} });
    const controller = { isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {} };
    const stream = createDisconnectAwareStream({ readable, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } }, controller, null, { onTerminate });
    await stream.cancel("client_closed");
    expect(onTerminate).toHaveBeenCalledOnce();
  });

  it("finalizeAborted records what was streamed, flagged aborted, once", async () => {
    const onStreamComplete = vi.fn();
    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-5", "conn", { messages: [{ role: "user", content: "hi" }] }, onStreamComplete, null, "openai");
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    writer.write(encoder.encode(sse({ choices: [{ delta: { content: "partial answer" } }] })));
    await reader.read();
    transform.finalizeAborted();
    transform.finalizeAborted();
    expect(onStreamComplete).toHaveBeenCalledOnce();
    const [content, usage, , meta] = onStreamComplete.mock.calls[0];
    expect(content.content).toContain("partial answer");
    expect(usage?.completion_tokens || usage?.output_tokens).toBeGreaterThan(0);
    expect(meta).toEqual({ aborted: true });
  });
});
