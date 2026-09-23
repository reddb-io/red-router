// Anthropic rejects a Claude Code identity older than a model needs with
// 400 claude_code_version_too_old ("... version X.Y.Z or newer is required").
// The router adopts that version (upward only, env pin wins) and resends once,
// with the User-Agent and billing header recomputed for the new version.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { applyCloaking } = await import("../../open-sse/utils/claudeCloaking.js");
const { CLAUDE_CLI_VERSION } = await import("../../open-sse/providers/shared.js");
const {
  CLAUDE_CODE_VERSION_ENV,
  adoptClaudeCodeVersion,
  getClaudeCodeVersion,
  parseRequiredClaudeCodeVersion,
  resetAdoptedClaudeCodeVersion,
} = await import("../../open-sse/utils/claudeCodeVersion.js");

const NEWER = "9.9.9";

function tooOld(version) {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "claude_code_version_too_old",
      message: `claude_code_version_too_old: Claude Code version ${version} or newer is required to use this model.`,
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } });
}

function ok() {
  return new Response("event: message_start\ndata: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function claudeBody() {
  return applyCloaking({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, "sk-ant-oat-test", "session-id");
}

const run = (body) => new DefaultExecutor("claude").execute({
  model: "claude-opus-5-5",
  body,
  stream: true,
  credentials: { accessToken: "sk-ant-oat-test" },
});

const sentUserAgent = (call) => call[1].headers["User-Agent"];
const sentBilling = (call) => JSON.parse(call[1].body).system[0].text;

beforeEach(() => {
  fetchMock.mockReset();
  resetAdoptedClaudeCodeVersion();
  delete process.env[CLAUDE_CODE_VERSION_ENV];
});

afterEach(() => {
  resetAdoptedClaudeCodeVersion();
  delete process.env[CLAUDE_CODE_VERSION_ENV];
});

describe("parseRequiredClaudeCodeVersion", () => {
  it("reads the required version from a claude_code_version_too_old 400", () => {
    const text = '{"error":{"code":"claude_code_version_too_old","message":"Claude Code version 2.1.301 or newer is required"}}';
    expect(parseRequiredClaudeCodeVersion(400, text)).toBe("2.1.301");
  });

  it("ignores other statuses and other 400s", () => {
    expect(parseRequiredClaudeCodeVersion(403, "claude_code_version_too_old 2.1.301 or newer is required")).toBeNull();
    expect(parseRequiredClaudeCodeVersion(400, '{"error":{"message":"max_tokens: too large"}}')).toBeNull();
  });
});

describe("adoptClaudeCodeVersion", () => {
  it("only ever raises the advertised version", () => {
    expect(adoptClaudeCodeVersion("0.0.1")).toBe(false);
    expect(getClaudeCodeVersion()).toBe(CLAUDE_CLI_VERSION);
    expect(adoptClaudeCodeVersion(NEWER)).toBe(true);
    expect(getClaudeCodeVersion()).toBe(NEWER);
    expect(adoptClaudeCodeVersion(NEWER)).toBe(false);
  });

  it("never overrides the env pin", () => {
    process.env[CLAUDE_CODE_VERSION_ENV] = "2.1.290";
    expect(adoptClaudeCodeVersion(NEWER)).toBe(false);
    expect(getClaudeCodeVersion()).toBe("2.1.290");
  });
});

describe("DefaultExecutor (claude) on claude_code_version_too_old", () => {
  it("adopts the required version and resends once with a recomputed identity", async () => {
    fetchMock.mockResolvedValueOnce(tooOld(NEWER)).mockResolvedValueOnce(ok());

    const out = await run(claudeBody());

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls;
    expect(sentUserAgent(first)).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`);
    expect(sentBilling(first)).toContain(`cc_version=${CLAUDE_CLI_VERSION}.`);
    expect(sentUserAgent(second)).toBe(`claude-cli/${NEWER} (external, sdk-cli)`);
    expect(sentBilling(second)).toContain(`cc_version=${NEWER}.`);
    expect(getClaudeCodeVersion()).toBe(NEWER);
  });

  it("keeps the adopted version for later requests", async () => {
    fetchMock.mockResolvedValueOnce(tooOld(NEWER)).mockResolvedValue(ok());
    await run(claudeBody());
    await run(claudeBody());

    const third = fetchMock.mock.calls[2];
    expect(sentUserAgent(third)).toBe(`claude-cli/${NEWER} (external, sdk-cli)`);
    expect(sentBilling(third)).toContain(`cc_version=${NEWER}.`);
  });

  it("retries only once and returns the second rejection", async () => {
    fetchMock.mockImplementation(async () => tooOld(NEWER));

    const out = await run(claudeBody());

    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the env pin keeps the version below the requirement", async () => {
    process.env[CLAUDE_CODE_VERSION_ENV] = "2.1.290";
    fetchMock.mockResolvedValueOnce(tooOld(NEWER));

    const out = await run(claudeBody());

    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUserAgent(fetchMock.mock.calls[0])).toBe("claude-cli/2.1.290 (external, sdk-cli)");
    expect(sentBilling(fetchMock.mock.calls[0])).toContain("cc_version=2.1.290.");
  });

  it("passes any other 400 straight through", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"bad"}}', { status: 400 }));

    const out = await run(claudeBody());

    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(out.response.text()).resolves.toContain("bad");
  });
});
