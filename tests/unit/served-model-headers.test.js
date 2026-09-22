// Successful chat responses name the model that served them and, where it can be
// known, what the turn cost: a header for JSON, `usage.cost` in the final usage
// event for streams. Everything fails open to the unmodified response.
import { describe, it, expect, vi, beforeEach } from "vitest";

const pricing = { value: { input: 2, output: 10 } };
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({
  getPricingForModel: vi.fn(async () => pricing.value),
}));
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => {}),
}));

const {
  servedModelId,
  costFromUsage,
  costHeaders,
  formatCostHeader,
  createUsageCostStream,
} = await import("../../open-sse/utils/servedHeaders.js");
const { withRequestId } = await import("../../open-sse/utils/error.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

beforeEach(() => {
  pricing.value = { input: 2, output: 10 };
});

async function pipe(lines, options) {
  const source = new Response(lines.join("")).body;
  return new Response(source.pipeThrough(createUsageCostStream(options))).text();
}

function dataEvents(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5)));
}

describe("servedModelId", () => {
  it("reports the addressed provider/model without a thinking suffix", () => {
    expect(servedModelId("cc/claude-sonnet-4-5(high)", "claude", "claude-sonnet-4-5")).toBe("cc/claude-sonnet-4-5");
    expect(servedModelId("gh/gpt-4o", "github", "gpt-4o")).toBe("gh/gpt-4o");
  });

  it("falls back to the resolved provider/model for bare aliases", () => {
    expect(servedModelId("my-alias", "openai", "gpt-4o")).toBe("openai/gpt-4o");
  });
});

describe("cost helpers", () => {
  it("prices canonical usage in any format", () => {
    // 1000 * $2/M + 500 * $10/M
    expect(costFromUsage({ prompt_tokens: 1000, completion_tokens: 500 }, pricing.value)).toBeCloseTo(0.007, 10);
    expect(costFromUsage({ input_tokens: 1000, output_tokens: 500 }, pricing.value)).toBeCloseTo(0.007, 10);
    expect(costFromUsage({ prompt_tokens: 1 }, null)).toBeNull();
    expect(costFromUsage(null, pricing.value)).toBeNull();
  });

  it("formats the header as a plain decimal", () => {
    expect(formatCostHeader(0.007)).toBe("0.007");
    expect(formatCostHeader(0.0000002)).toBe("0.0000002");
    expect(formatCostHeader(0)).toBe("0");
  });

  it("omits the cost header when the model is unpriced", async () => {
    expect(await costHeaders("openai", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 })).toEqual({ "X-RedRouter-Cost-USD": "0.007" });
    pricing.value = null;
    expect(await costHeaders("openai", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 })).toEqual({});
    expect(await costHeaders("openai", "gpt-4o", null)).toEqual({});
  });
});

describe("createUsageCostStream", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 500 };

  it("adds usage.cost to the OpenAI chunk that carries usage", async () => {
    const text = await pipe([
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ], { pricing: Promise.resolve(pricing.value) });
    const events = dataEvents(text);
    expect(events[0].usage).toBeUndefined();
    expect(events[1].usage.cost).toBeCloseTo(0.007, 10);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("adds usage.cost to the Anthropic message_delta only", async () => {
    const text = await pipe([
      "event: message_start\n",
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1000 } } })}\n\n`,
      "event: message_delta\n",
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } })}\n\n`,
    ], { pricing: Promise.resolve(pricing.value), currentUsage: () => ({ input_tokens: 1000, output_tokens: 500 }) });
    const [start, delta] = dataEvents(text);
    expect(start.message.usage.cost).toBeUndefined();
    expect(delta.usage.cost).toBeCloseTo(0.007, 10);
    expect(text).toContain("event: message_delta\n");
  });

  it("adds usage.cost to the terminal Responses event", async () => {
    const text = await pipe([
      "event: response.completed\n",
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 500 } } })}\n\n`,
    ], { pricing: Promise.resolve(pricing.value) });
    expect(dataEvents(text)[0].response.usage.cost).toBeCloseTo(0.007, 10);
  });

  it("passes the stream through untouched when the model is unpriced", async () => {
    const lines = [`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [], usage })}\n\n`, "data: [DONE]\n\n"];
    expect(await pipe(lines, { pricing: Promise.resolve(null) })).toBe(lines.join(""));
  });
});

describe("withRequestId", () => {
  it("sets X-Request-Id and the served model on success, and exposes both", () => {
    const response = withRequestId(new Response("{}"), { requestId: "req_1", errorFormat: FORMATS.CLAUDE }, { servedModel: "cc/claude-sonnet-4-5" });
    expect(response.headers.get("X-Request-Id")).toBe("req_1");
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.get("X-RedRouter-Served-Model")).toBe("cc/claude-sonnet-4-5");
    const exposed = response.headers.get("Access-Control-Expose-Headers");
    expect(exposed).toContain("X-RedRouter-Served-Model");
    expect(exposed).toContain("X-RedRouter-Cost-USD");
    expect(exposed).toContain("X-Request-Id");
  });

  it("never labels an error with a served model", () => {
    const response = withRequestId(new Response("{}", { status: 429 }), { requestId: "req_2" }, { servedModel: "gh/gpt-4o" });
    expect(response.headers.get("X-RedRouter-Served-Model")).toBeNull();
    expect(response.headers.get("X-Request-Id")).toBe("req_2");
  });
});

describe("chatCore handlers", () => {
  const shared = {
    provider: "openai",
    model: "gpt-4o",
    body: {},
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    clientRawRequest: null,
    onRequestSuccess: null,
    toolNameMap: null,
    customToolNames: null,
    pxpipe: null,
    decision: null,
    reqTag: "",
    log: null,
  };

  it("non-streaming responses carry X-RedRouter-Cost-USD", async () => {
    const providerResponse = new Response(JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    }), { headers: { "content-type": "application/json" } });
    const result = await handleNonStreamingResponse({
      ...shared,
      providerResponse,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      stream: false,
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
      trackDone: () => {},
      appendLog: () => {},
    });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("X-RedRouter-Cost-USD")).toBe("0.007");
  });

  it("streaming responses carry usage.cost in the final usage chunk", async () => {
    const upstream = [
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const result = await handleStreamingResponse({
      ...shared,
      providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      stream: true,
      userAgent: "",
      reqLogger: null,
      streamController: createStreamController({ provider: "openai", model: "gpt-4o" }),
      onStreamComplete: null,
      streamDetailId: "d1",
    });
    expect(result.success).toBe(true);
    const events = dataEvents(await result.response.text());
    const withUsage = events.filter((event) => event.usage);
    expect(withUsage.length).toBeGreaterThan(0);
    // Priced from the upstream usage (1000 in / 500 out), not the buffered client copy.
    expect(withUsage.at(-1).usage.cost).toBeCloseTo(0.007, 10);
  });
});
