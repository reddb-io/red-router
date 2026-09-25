import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), getApiKeyAllowedConnectionIds: vi.fn(), getCombos: vi.fn(),
  getCustomModels: vi.fn(), getModelAliases: vi.fn(), getDisabledModels: vi.fn(), getApiKeyPolicy: vi.fn(),
  getSettings: vi.fn(), getPricingForModel: vi.fn(), isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ ...mocks }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricingForModel: mocks.getPricingForModel }));

const { handleMcpBody, handleMcpMessage } = await import("@/lib/mcp/server.js");
const { RED_ROUTER_TOOLS } = await import("@/lib/mcp/redRouterTools.js");

const conn = (id, provider, models, extra = {}) => ({ id, provider, authType: "apikey", isActive: true, priority: 1, providerSpecificData: { enabledModels: models }, ...extra });
const server = { info: { name: "red-router", version: "test" }, tools: RED_ROUTER_TOOLS, context: { apiKey: null } };
const call = async (name, args = {}) => {
  const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, server);
  return res.result;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([{ id: "c1", name: "cheap-first", models: ["openrouter/anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5"] }]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.getApiKeyPolicy.mockResolvedValue({ id: null, modelAccess: null, limits: null });
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getSettings.mockResolvedValue({});
  mocks.getPricingForModel.mockImplementation(async (provider) => (provider === "openrouter" ? { input: 3, output: 15 } : { input: 2, output: 10 }));
  mocks.getProviderConnections.mockResolvedValue([
    conn("a", "openrouter", ["anthropic/claude-sonnet-4.5"]),
    conn("b", "anthropic", ["claude-sonnet-4-5"], { rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() }),
    conn("c", "anthropic", ["claude-sonnet-4-5"], { isActive: false }),
  ]);
});

describe("MCP protocol", () => {
  it("negotiates the protocol version and lists read-only tools", async () => {
    const init = await handleMcpBody(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } }), server);
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "red-router" } });
    const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, server);
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
    const { result } = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, server);
    expect(result.tools.map((t) => t.name)).toEqual(["list_models", "get_model", "list_combos", "list_providers", "recommend_models", "get_usage"]);
    expect(result.tools.every((t) => t.annotations.readOnlyHint === true && !("run" in t))).toBe(true);
  });

  it("answers notifications with nothing and bad input with JSON-RPC errors", async () => {
    expect(await handleMcpBody(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), server)).toBeNull();
    expect((await handleMcpBody("{nope", server)).error.code).toBe(-32700);
    expect((await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, server)).error.code).toBe(-32601);
    const bad = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_model", arguments: {} } }, server);
    expect(bad.error).toMatchObject({ code: -32602, data: 'missing required argument "id"' });
  });
});

describe("RedRouter tools", () => {
  it("lists models and combos with capabilities and price", async () => {
    const { structuredContent: out } = await call("list_models");
    const byId = Object.fromEntries(out.models.map((m) => [m.id, m]));
    expect(byId["openrouter/anthropic/claude-sonnet-4.5"]).toMatchObject({ kind: "model", price_per_million: { input: 3, output: 15 } });
    expect(byId["cheap-first"]).toMatchObject({ kind: "combo", strategy: "fallback", members: ["openrouter/anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5"] });
    expect(byId["cheap-first"].capabilities).toContain("tools");
    const filtered = (await call("list_models", { search: "openrouter", include_combos: false })).structuredContent;
    expect(filtered.models.map((m) => m.id)).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
  });

  it("describes a combo's members in the order they are tried", async () => {
    const { structuredContent: out } = await call("get_model", { id: "cheap-first" });
    expect(out.model.member_details.map((m) => m.id)).toEqual(["openrouter/anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4-5"]);
    const missing = await call("get_model", { id: "nope/nothing" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("unknown_model");
  });

  it("only recommends usable models, ranked by price, and never switches anything", async () => {
    // Anthropic's only enabled account is rate limited: its direct model is not usable.
    const { structuredContent: out } = await call("recommend_models", { needs: ["tools"] });
    // The combo's price is its first usable member's: the same OpenRouter model.
    expect(out.recommendations.map((r) => r.id).sort()).toEqual(["cheap-first", "openrouter/anthropic/claude-sonnet-4.5"]);
    expect(out.recommendations.find((r) => r.id === "cheap-first")).toMatchObject({ usable: true, price_per_million: { input: 3, output: 15 } });
    expect(out.recommendations[0].why).toContainEqual({ code: "tools", detail: "supports tools" });
    expect(out.note).toMatch(/after the user agrees/);
  });

  it("explains a switch away from the current model with a delta and reason codes", async () => {
    const { structuredContent: out } = await call("recommend_models", { current: "anthropic/claude-sonnet-4-5", include_combos: false });
    expect(out.current).toMatchObject({ usable: false, status: { state: "rate_limited" } });
    const [pick] = out.recommendations;
    expect(pick.id).toBe("openrouter/anthropic/claude-sonnet-4.5");
    expect(pick.delta).toEqual({ price_delta_pct: 50, context_delta: 0, gained_capabilities: [], lost_capabilities: [] });
    expect(pick.why.map((r) => r.code)).toContain("rate_limited");
    const unknown = await call("recommend_models", { current: "nope/nothing" });
    expect(unknown.structuredContent.error.code).toBe("unknown_model");
  });

  it("finds equivalents only when they are cheaper or healthier", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn("a", "openrouter", ["anthropic/claude-sonnet-4.5"]),
      conn("b", "anthropic", ["claude-sonnet-4-5"]),
    ]);
    const cheaper = (await call("recommend_models", { equivalent_to: "openrouter/anthropic/claude-sonnet-4.5", include_combos: false })).structuredContent;
    expect(cheaper.recommendations.map((r) => r.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(cheaper.recommendations[0].why.map((r) => r.code)).toContain("cheaper");
    const none = (await call("recommend_models", { equivalent_to: "anthropic/claude-sonnet-4-5", include_combos: false })).structuredContent;
    expect(none.recommendations).toEqual([]);
  });

  it("marks each model's status, usability and free flag", async () => {
    const { structuredContent: out } = await call("list_models", { include_combos: false });
    const byId = Object.fromEntries(out.models.map((m) => [m.id, m]));
    expect(byId["openrouter/anthropic/claude-sonnet-4.5"]).toMatchObject({ usable: true, free: false, status: { state: "ok" } });
    expect(byId["anthropic/claude-sonnet-4-5"].status.state).toBe("rate_limited");
    expect(byId["anthropic/claude-sonnet-4-5"].status.until).toBeTruthy();
  });

  it("reports providers by account status without account details", async () => {
    const { structuredContent: out } = await call("list_providers");
    const anthropic = out.providers.find((p) => p.id === "anthropic");
    expect(anthropic.accounts).toEqual({ total: 2, ok: 0, rate_limited: 1, error: 0, disabled: 1 });
    expect(anthropic.usable).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/"(email|apiKey|accessToken)"/);
  });

  it("only reports usage for a key", async () => {
    const res = await call("get_usage");
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe("forbidden");
  });
});

describe("/v1/mcp", () => {
  const post = async (body, headers = {}) => {
    vi.doMock("@/sse/services/auth.js", () => ({
      extractApiKey: (req) => req.headers.get("authorization")?.replace(/^Bearer /, "") || null,
      isValidApiKey: mocks.isValidApiKey,
    }));
    const { POST } = await import("@/app/api/v1/mcp/route.js");
    return POST(new Request("http://localhost:25050/v1/mcp", { method: "POST", headers: { host: "localhost:25050", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  };

  it("refuses a foreign browser origin and an invalid or missing key when keys are required", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
    mocks.isValidApiKey.mockResolvedValue(false);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer sk-bad" })).status).toBe(401);
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("answers requests and accepts notifications with 202", async () => {
    const res = await post({ jsonrpc: "2.0", id: 7, method: "ping" }, { origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-redrouter-mcp-version")).toBe("2");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
});
