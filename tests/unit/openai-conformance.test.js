// OpenAI API conformance: RedRouter's /v1 answers validated against OpenAI's own
// OpenAPI schemas (tests/fixtures/openai/schemas.json, refreshed by
// scripts/sync-openai-schemas.mjs). Only the upstream is faked; routing,
// translation and response shaping are the real code, for OpenAI, Claude and
// Gemini upstreams, JSON and streaming.
import { beforeAll, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import schemas from "../fixtures/openai/schemas.json" with { type: "json" };

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: "openai", components: schemas.components });
const validators = new Map();
function conforms(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.getSchema(`openai#/components/schemas/${name}`));
  const validate = validators.get(name);
  const ok = validate(value);
  return ok ? "ok" : `${name}: ${ajv.errorsText(validate.errors, { separator: "\n  " })}\n${JSON.stringify(value).slice(0, 600)}`;
}

let handleChatCore;
let errorResponse;
let responseFromRoutingCandidate;
let listModels;
let getModel;
let db;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.createCombo({ name: "conformance-combo", models: ["cc/claude-opus-5-5", "gh/gpt-4o"] });
  ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
  ({ errorResponse, responseFromRoutingCandidate } = await import("../../open-sse/utils/error.js"));
  ({ GET: listModels } = await import("../../src/app/api/v1/models/route.js"));
  ({ GET: getModel } = await import("../../src/app/api/v1/models/[...model]/route.js"));
}, 60_000);

// ── upstream fixtures: one text answer and one tool call, per wire format ─────

const TOOL = { name: "get_weather", arguments: { city: "Lisbon" } };
const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };

const upstream = {
  openai: {
    json: (tool) => ({
      id: "chatcmpl-up", object: "chat.completion", created: 1735689600, model: "deepseek-chat",
      choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", logprobs: null,
        message: tool
          ? { role: "assistant", content: null, refusal: null, tool_calls: [{ id: "call_1", type: "function", function: { name: TOOL.name, arguments: JSON.stringify(TOOL.arguments) } }] }
          : { role: "assistant", content: "Hello there", refusal: null } }],
      usage,
    }),
    sse: (tool) => {
      const base = { id: "chatcmpl-up", object: "chat.completion.chunk", created: 1735689600, model: "deepseek-chat" };
      const events = tool
        ? [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: TOOL.name, arguments: "" } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(TOOL.arguments) } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
        : [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
      events.push({ ...base, choices: [], usage });
      return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    },
  },
  claude: {
    json: (tool) => ({
      id: "msg_up", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: tool ? [{ type: "tool_use", id: "toolu_1", name: TOOL.name, input: TOOL.arguments }] : [{ type: "text", text: "Hello there" }],
      stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 7 },
    }),
    sse: (tool) => {
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return [
        ev("message_start", { message: { id: "msg_up", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
        tool
          ? ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: TOOL.name, input: {} } })
          : ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        tool
          ? ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL.arguments) } })
          : ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello there" } }),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
        ev("message_stop", {}),
      ].join("");
    },
  },
  gemini: {
    json: (tool) => ({
      candidates: [{ index: 0, finishReason: "STOP",
        content: { role: "model", parts: tool ? [{ functionCall: { name: TOOL.name, args: TOOL.arguments } }] : [{ text: "Hello there" }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 },
      modelVersion: "gemini-2.5-flash",
    }),
    sse: (tool) => {
      const chunks = tool
        ? [{ candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: TOOL.name, args: TOOL.arguments } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } }]
        : [
          { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello" }] } }] },
          { candidates: [{ index: 0, content: { role: "model", parts: [{ text: " there" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } },
        ];
      return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
    },
  },
};

const PROVIDERS = [
  { format: "openai", provider: "deepseek", model: "deepseek-chat" },
  { format: "claude", provider: "claude", model: "claude-sonnet-4-6" },
  { format: "gemini", provider: "gemini", model: "gemini-2.5-flash" },
];

async function chat({ format, provider, model }, { stream, tool, endpoint = "/v1/chat/completions", sourceFormat = null, body: bodyOverride = null }) {
  executeMock.mockImplementation(async () => ({
    response: stream
      ? new Response(upstream[format].sse(tool), { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(upstream[format].json(tool)), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://upstream.invalid/v1",
    headers: {},
  }));
  const body = bodyOverride || {
    model: `${provider}/${model}`,
    stream,
    messages: [{ role: "user", content: "hi" }],
    ...(tool ? { tools: [{ type: "function", function: { name: TOOL.name, parameters: { type: "object", properties: { city: { type: "string" } } } } }] } : {}),
  };
  const result = await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, line() {}, errorLine() {} },
    connectionId: "conformance",
    rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, adhdEnabled: false, pxpipeEnabled: false,
    clientRawRequest: { endpoint, body, headers: {} },
    sourceFormatOverride: sourceFormat,
  });
  expect(result.success, JSON.stringify(result).slice(0, 300)).toBe(true);
  return result.response;
}

function dataEvents(text) {
  return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
}

// ── models ────────────────────────────────────────────────────────────────────

describe("GET /v1/models", () => {
  it("is a ListModelsResponse whose entries are Model objects", async () => {
    const res = await listModels(new Request("http://localhost/v1/models"));
    const body = await res.json();
    expect(conforms("ListModelsResponse", body)).toBe("ok");
    expect(body.data.length).toBeGreaterThan(0);
    const combo = body.data.find((m) => m.id === "conformance-combo");
    expect(conforms("Model", combo)).toBe("ok");
    // Stable across calls: `created` must not follow the clock.
    const again = await (await listModels(new Request("http://localhost/v1/models"))).json();
    expect(again.data.map((m) => m.created)).toEqual(body.data.map((m) => m.created));
  });

  it("GET /v1/models/{id} is a Model, and an unknown id a 404 ErrorResponse", async () => {
    const list = await (await listModels(new Request("http://localhost/v1/models"))).json();
    const id = list.data.find((m) => m.owned_by !== "combo").id;
    const one = await getModel(new Request(`http://localhost/v1/models/${id}`), { params: Promise.resolve({ model: id.split("/") }) });
    expect(conforms("Model", await one.json())).toBe("ok");
    const missing = await getModel(new Request("http://localhost/v1/models/nope/nothing"), { params: Promise.resolve({ model: ["nope", "nothing"] }) });
    expect(missing.status).toBe(404);
    expect(conforms("ErrorResponse", await missing.json())).toBe("ok");
  });
});

// ── errors ────────────────────────────────────────────────────────────────────

describe("errors", () => {
  it("every status the router answers is an ErrorResponse", async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
      const res = errorResponse(status, `failure ${status}`);
      expect(res.status).toBe(status);
      expect(conforms("ErrorResponse", await res.json())).toBe("ok");
    }
    for (const reason of ["model_disabled", "model_not_allowed", "api_key_limit", "no_active_credentials", "quota_exhausted"]) {
      const res = responseFromRoutingCandidate({ reason, status: reason === "api_key_limit" || reason === "quota_exhausted" ? 429 : 403, message: reason, retryAtMs: Date.now() + 5000 });
      expect(conforms("ErrorResponse", await res.json())).toBe("ok");
    }
  });
});

// ── chat completions ──────────────────────────────────────────────────────────

describe.each(PROVIDERS)("chat completions from a $format upstream", (target) => {
  it.each([false, true])("JSON answer (tool call: %s) is a CreateChatCompletionResponse", async (tool) => {
    const res = await chat(target, { stream: false, tool });
    const body = await res.json();
    expect(conforms("CreateChatCompletionResponse", body)).toBe("ok");
    if (tool) expect(body.choices[0].message.tool_calls?.[0]?.function?.name).toBe(TOOL.name);
    else expect(body.choices[0].message.content).toContain("Hello");
  });

  it.each([false, true])("stream (tool call: %s) is CreateChatCompletionStreamResponse chunks ending in [DONE]", async (tool) => {
    const res = await chat(target, { stream: true, tool });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = dataEvents(await res.text());
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(conforms("CreateChatCompletionStreamResponse", chunk)).toBe("ok");
    expect(chunks.some((c) => c.choices?.some((ch) => ch.finish_reason))).toBe(true);
  });
});

// ── responses API ─────────────────────────────────────────────────────────────

describe("responses API", () => {
  it.each(PROVIDERS)("a JSON answer from a $format upstream is a Response", async (target) => {
    const body = { model: `${target.provider}/${target.model}`, input: "hi", stream: false };
    const res = await chat(target, { stream: false, tool: false, endpoint: "/v1/responses", sourceFormat: "openai-responses", body });
    expect(conforms("Response", await res.json())).toBe("ok");
  });
});
