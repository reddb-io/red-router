// /v1/messages/count_tokens: exact count from Anthropic for a first-party model
// (with the key checked), the local estimate otherwise.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ settings: { requireApiKey: true }, fetch: vi.fn(), info: { provider: "claude", model: "claude-opus-5-5" }, valid: true }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => m.settings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async () => m.info }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (req) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null,
  isValidApiKey: async () => m.valid,
  getProviderCredentials: async () => ({ accessToken: "oauth", providerSpecificData: {} }),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => m.fetch(...a) }));

const { POST } = await import("../../src/app/api/v1/messages/count_tokens/route.js");
const call = (body = { model: "claude/claude-opus-5-5", messages: [{ role: "user", content: "hello world" }] }) =>
  POST(new Request("http://x/v1/messages/count_tokens", {
    method: "POST",
    headers: { authorization: "Bearer sk-k", "anthropic-beta": "context-1m-2025-08-07", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  m.fetch.mockReset();
  m.settings = { requireApiKey: true };
  m.valid = true;
  m.info = { provider: "claude", model: "claude-opus-5-5" };
});

describe("count_tokens", () => {
  it("returns Anthropic's exact count for a first-party model", async () => {
    m.fetch.mockResolvedValue(new Response(JSON.stringify({ input_tokens: 4242 }), { status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" } }));
    const res = await call();
    expect(await res.json()).toEqual({ input_tokens: 4242 });
    const [url, init] = m.fetch.mock.calls[0];
    expect(url).toMatch(/\/messages\/count_tokens(\?|$)/);
    expect(init.headers["anthropic-beta"]).toContain("context-1m-2025-08-07");
    expect(JSON.parse(init.body).model).toBe("claude-opus-5-5");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
  });

  it("estimates without calling upstream for a non-Anthropic model, an invalid key, or an upstream failure", async () => {
    m.info = { provider: "openai", model: "gpt-5" };
    expect((await (await call()).json()).input_tokens).toBeGreaterThan(0);
    m.info = { provider: "claude", model: "claude-opus-5-5" };
    m.valid = false;
    await call();
    expect(m.fetch).not.toHaveBeenCalled();
    m.valid = true;
    m.fetch.mockResolvedValue(new Response("nope", { status: 500 }));
    expect((await (await call()).json()).input_tokens).toBeGreaterThan(0);
  });
});
