import { describe, it, expect, vi, beforeEach } from "vitest";
import { ADHD_PROMPTS } from "../../open-sse/rtk/adhdPrompt.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function run({ headers = {}, ...flags }) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() };
  return handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log,
    connectionId: "test-conn",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    ...flags,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json", ...headers },
    },
  }).then(() => ({ log, body: executeMock.mock.calls.at(-1)[0].body }));
}

describe("handleChatCore ADHD mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });
    executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
  });

  it("injects the configured level and records it on the token-saver line", async () => {
    const { log, body } = await run({ adhdEnabled: true, adhdLevel: "lite" });
    expect(body.messages[0].content).toBe(`base\n\n${ADHD_PROMPTS.lite}`);
    const saverLine = log.line.mock.calls.find((call) => call[1] === "⚙");
    expect(saverLine?.[2]).toContain("ADHD:lite");
  });

  it("does nothing when disabled", async () => {
    const { body } = await run({ adhdEnabled: false, adhdLevel: "full" });
    expect(body.messages[0].content).toBe("base");
  });

  it("stacks after caveman and ponytail", async () => {
    const { log, body } = await run({
      cavemanEnabled: true, cavemanLevel: "full",
      ponytailEnabled: true, ponytailLevel: "full",
      adhdEnabled: true, adhdLevel: "full",
    });
    expect(body.messages[0].content).toBe(["base", CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full, ADHD_PROMPTS.full].join("\n\n"));
    const saverLine = log.line.mock.calls.find((call) => call[1] === "⚙");
    expect(saverLine?.[2]).toBe("CAVEMAN:full · PONYTAIL:full · ADHD:full");
  });

  it("honours the per-request token-saver opt-out header", async () => {
    const { body } = await run({ adhdEnabled: true, adhdLevel: "full", headers: { "x-red-router-token-saver": "off" } });
    expect(body.messages[0].content).toBe("base");
  });
});
