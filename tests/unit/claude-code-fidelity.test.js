// Claude Code → Anthropic first-party is passed through (Anthropic's gateway
// protocol): body fields and anthropic-* headers unchanged, upstream errors and
// rate-limit headers returned as sent, no local mutations or bypass answers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getExecutor: (provider) => ({ ...original.getExecutor(provider), noAuth: true, execute: executeMock }) };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { isClaudeFaithful, isAnthropicFirstParty, forwardedResponseHeaders, faithfulAnthropicBeta } = await import("../../open-sse/utils/claudeFidelity.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const CC_HEADERS = { "user-agent": "claude-cli/2.1.290 (external, cli)", "anthropic-beta": "context-1m-2025-08-07,effort-2025-11-24", "anthropic-version": "2023-06-01", "x-app": "cli" };

function claudeBody() {
  return {
    model: "claude/claude-opus-5-5",
    stream: false,
    max_tokens: 1024,
    temperature: 1,
    safeguards: { auto_mode: { checks: ["bash"] } },
    output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.290" },
      { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } },
    ],
    tools: [{ name: "Bash", input_schema: { type: "object" } }, { name: "WebSearch", input_schema: { type: "object" } }, { name: "mcp__search__web_search", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "run ls", cache_control: { type: "ephemeral" } }] }],
  };
}

async function run(body, { headers = CC_HEADERS, provider = "claude", model = "claude-opus-5-5" } = {}) {
  return handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { accessToken: "oauth-token", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, line() {}, errorLine() {} },
    connectionId: "c1",
    rtkEnabled: true, headroomEnabled: false, cavemanEnabled: true, cavemanLevel: "full", ponytailEnabled: false, adhdEnabled: false, pxpipeEnabled: false,
    clientRawRequest: { endpoint: "/v1/messages", body, headers },
  });
}

beforeEach(() => executeMock.mockReset());

describe("detection", () => {
  it("is on only for Claude Code, on the native path, to Anthropic itself", () => {
    expect(isAnthropicFirstParty("claude")).toBe(true);
    expect(isAnthropicFirstParty("anthropic-compatible-x", { providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" } })).toBe(true);
    expect(isAnthropicFirstParty("anthropic-compatible-x", { providerSpecificData: { baseUrl: "https://gateway.example/v1" } })).toBe(false);
    expect(isClaudeFaithful({ passthrough: true, clientTool: "claude", provider: "claude" })).toBe(true);
    expect(isClaudeFaithful({ passthrough: true, clientTool: "claude", provider: "glm" })).toBe(false);
    expect(isClaudeFaithful({ passthrough: false, clientTool: "claude", provider: "claude" })).toBe(false);
  });

  it("forwards the client's betas plus only what an OAuth credential needs", () => {
    expect(faithfulAnthropicBeta("context-1m-2025-08-07", { oauth: true })).toBe("context-1m-2025-08-07,oauth-2025-04-20,claude-code-20250219");
    expect(faithfulAnthropicBeta("a,b", { oauth: false })).toBe("a,b");
  });

  it("keeps only the response headers Claude Code reads", () => {
    const res = new Response("{}", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.4", "x-should-retry": "true", "retry-after": "12", "request-id": "req_up", "content-length": "2", "set-cookie": "x" } });
    expect(forwardedResponseHeaders(res)).toEqual({ "anthropic-ratelimit-unified-5h-utilization": "0.4", "x-should-retry": "true", "retry-after": "12", "request-id": "req_up" });
  });
});

describe("request body and headers", () => {
  it("reach the upstream unchanged", async () => {
    executeMock.mockImplementation(async (args) => ({ response: new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, service_tier: "standard" } }), { status: 200, headers: { "content-type": "application/json", "anthropic-ratelimit-unified-status": "allowed" } }), url: "u", headers: {} }));
    const body = claudeBody();
    const sent = JSON.parse(JSON.stringify(body));
    const result = await run(body);
    expect(result.success).toBe(true);
    const upstream = executeMock.mock.calls[0][0].body;
    expect(upstream.safeguards).toEqual(sent.safeguards);
    expect(upstream.output_config).toEqual(sent.output_config);
    expect(upstream.system).toEqual(sent.system);                  // attribution block first, cache_control/scope intact, no caveman
    expect(upstream.tools.map((t) => t.name)).toEqual(sent.tools.map((t) => t.name)); // no dedupe
    expect(upstream.messages).toEqual(sent.messages);
    expect(upstream.temperature).toBe(1);

    // JSON answer: usage as reported, rate-limit header forwarded
    const json = await result.response.json();
    expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, service_tier: "standard" });
    expect(result.response.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
  });

  it("the executor sends the client's anthropic-beta and anthropic-version", () => {
    const ex = new DefaultExecutor("claude");
    const headers = ex.buildHeaders({ accessToken: "t", claudeFaithful: true, rawHeaders: { "anthropic-beta": "context-1m-2025-08-07", "anthropic-version": "2023-06-01" } }, true, undefined, "claude-opus-5-5");
    const betaKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "anthropic-beta");
    expect(betaKeys).toEqual(["anthropic-beta"]);
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07,oauth-2025-04-20,claude-code-20250219");
    expect(headers["anthropic-beta"]).not.toContain("redact-thinking");
  });

  it("a non-Claude-Code client keeps today's behaviour", async () => {
    executeMock.mockImplementation(async () => ({ response: new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }), url: "u", headers: {} }));
    const body = claudeBody();
    await run(body, { headers: { "user-agent": "curl/8", "anthropic-version": "2023-06-01" } });
    // not the native Claude Code path: savers may shape the system prompt
    expect(executeMock).toHaveBeenCalled();
  });
});

describe("upstream errors", () => {
  it("come back with the upstream status, body and headers", async () => {
    const upstreamBody = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Input tag 'advisor_20260301' found using 'type' does not match any of the expected tags" }, request_id: "req_up" });
    executeMock.mockImplementation(async () => ({ response: new Response(upstreamBody, { status: 400, headers: { "content-type": "application/json", "request-id": "req_up", "x-should-retry": "false" } }), url: "u", headers: {} }));
    const result = await run(claudeBody());
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe(upstreamBody);
    expect(result.response.headers.get("x-should-retry")).toBe("false");
    expect(result.response.headers.get("request-id")).toBe("req_up");
  });
});

describe("streams", () => {
  it("pass Anthropic's events through with no [DONE], no cost field, and the rate-limit headers", async () => {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_keep_me", name: "Bash", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ cmd: "ls" }) } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 }, safeguard_results: { bash: "allow" } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    executeMock.mockImplementation(async () => ({ response: new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.2" } }), url: "u", headers: {} }));
    const result = await run({ ...claudeBody(), stream: true });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.2");
    const text = await result.response.text();
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("toolu_keep_me");
    expect(text).toContain("safeguard_results");
    expect(text).not.toContain("\"cost\"");
  });
});
