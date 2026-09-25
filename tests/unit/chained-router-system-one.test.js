// System One ids through chained RedRouters: "red-router/opencode-zen/jev-1.13" is
// forwarded to the upstream router's /v1/systemone with that connection's key, the
// rest of the id intact, and the hop chain header extended. A loopback server plays
// the upstream router.
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleSystemOneCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: mocks.markAccountUnavailable,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: true }) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("open-sse/handlers/systemOneCore.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, handleSystemOneCore: mocks.handleSystemOneCore };
});
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

const { handleSystemOne } = await import("../../src/sse/handlers/systemOne.js");
const { getModelInfo, resolveRedRouterHop } = await import("../../src/sse/services/model.js");
const {
  RED_ROUTER_CHAIN_HEADER,
  RED_ROUTER_INSTANCE_ID,
  RED_ROUTER_MAX_HOPS,
} = await import("open-sse/config/redRouter.js");

let server;
let baseUrl;
let received = [];
// What the upstream router answers: a function of the parsed request.
let reply = null;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ path: req.url, headers: req.headers, body });
    const answer = await reply({ req, body, raw });
    const headers = Object.fromEntries(answer.headers.entries());
    res.writeHead(answer.status, headers);
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const routerCredentials = () => ({
  apiKey: "upstream-router-key",
  connectionId: "home-router",
  connectionName: "Home router",
  providerSpecificData: { baseUrl },
});

function makeRequest(model, headers = {}) {
  return new Request("http://router.test/v1/systemone", {
    method: "POST",
    headers: { Authorization: "Bearer client-key", "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      state: "Ship the incident fix now",
      questions: { urgency: { type: "noul", instructions: "Is it urgent?" } },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  received = [];
  reply = ({ body }) => Response.json({ answers: { urgency: { type: "noul", noul: 0.9 } }, model: body.model, usage: { input_tokens: 5, output_tokens: 1 } });
  mocks.getProviderCredentials.mockResolvedValue(routerCredentials());
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  mocks.saveRequestUsage.mockResolvedValue(undefined);
  mocks.handleSystemOneCore.mockResolvedValue({ success: true, status: 200, response: Response.json({ answers: {} }) });
});

describe("one parser for router hops", () => {
  it.each([
    ["red-router/opencode-zen/jev-1.13", "opencode-zen/jev-1.13"],
    ["red-router/red-router/opencode-go/jev-1.13", "red-router/opencode-go/jev-1.13"],
    ["red-router/red-router/red-router/openrouter/typesafe/jev-1.13", "red-router/red-router/openrouter/typesafe/jev-1.13"],
  ])("strips only this router's hop of %s", async (id, rest) => {
    expect(await getModelInfo(id)).toMatchObject({ provider: "red-router", model: rest });
    expect(await resolveRedRouterHop(id)).toEqual({ model: rest, connectionIds: null });
  });

  it("leaves flat ids alone", async () => {
    expect(await resolveRedRouterHop("opencode-zen/jev-1.13")).toBeNull();
    expect(await resolveRedRouterHop("jev-latest")).toBeNull();
  });
});

describe("/v1/systemone through chained RedRouters", () => {
  it.each([
    ["red-router/opencode-zen/jev-1.13", "opencode-zen/jev-1.13"],
    ["red-router/red-router/opencode-go/jev-1.13", "red-router/opencode-go/jev-1.13"],
    ["red-router/red-router/red-router/opencode-zen/jev-1.13", "red-router/red-router/opencode-zen/jev-1.13"],
  ])("forwards %s with the rest of the id and the connection's key", async (requested, forwarded) => {
    const response = await handleSystemOne(makeRequest(requested));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: forwarded });
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/v1/systemone");
    expect(received[0].headers.authorization).toBe("Bearer upstream-router-key");
    expect(received[0].headers[RED_ROUTER_CHAIN_HEADER]).toBe(RED_ROUTER_INSTANCE_ID);
    expect(received[0].body).toMatchObject({ model: forwarded, state: "Ship the incident fix now" });
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("red-router", expect.any(Set), forwarded, expect.objectContaining({ apiKey: "client-key" }));
    expect(mocks.handleSystemOneCore).not.toHaveBeenCalled();
  });

  it("extends the chain it received", async () => {
    await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13", { [RED_ROUTER_CHAIN_HEADER]: "rr-edge" }));

    expect(received[0].headers[RED_ROUTER_CHAIN_HEADER]).toBe(`rr-edge,${RED_ROUTER_INSTANCE_ID}`);
  });

  it("records the upstream router's exact usage under the RedRouter connection", async () => {
    await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13"));
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledOnce());

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "red-router",
      model: "opencode-zen/jev-1.13",
      connectionId: "home-router",
      tokens: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }));
  });

  it("keeps flat ids on this router's own System One providers", async () => {
    const response = await handleSystemOne(makeRequest("opencode-zen/jev-1.13"));

    expect(response.status).toBe(200);
    expect(received).toHaveLength(0);
    expect(mocks.handleSystemOneCore).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "opencode-zen",
      body: expect.objectContaining({ model: "jev-1.13" }),
    }));
  });

  it.each([401, 402, 403, 429])("passes a downstream %i back with the hop named", async (status) => {
    reply = () => Response.json(
      { error: { message: `RedRouter "Office router" answered HTTP ${status} for opencode-zen/jev-1.13: OpenCode Zen said no` } },
      { status, headers: status === 429 ? { "Retry-After": "30" } : {} },
    );

    const response = await handleSystemOne(makeRequest("red-router/red-router/opencode-zen/jev-1.13"));

    expect(response.status).toBe(status);
    if (status === 429) expect(response.headers.get("retry-after")).toBe("30");
    const message = (await response.json()).error.message;
    expect(message).toContain(`RedRouter "Home router" answered HTTP ${status} for red-router/opencode-zen/jev-1.13`);
    expect(message).toContain(`RedRouter "Office router" answered HTTP ${status}`);
    expect(message).toContain("OpenCode Zen said no");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("home-router", status, message, "red-router", "red-router/opencode-zen/jev-1.13", status === 429 ? expect.any(Number) : undefined);
  });

  it("names the hop it could not reach", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ ...routerCredentials(), providerSpecificData: { baseUrl: "http://127.0.0.1:1" } });

    const response = await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13"));

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain('RedRouter "Home router" could not be reached for opencode-zen/jev-1.13');
  });

  it("says so when no RedRouter connection can serve the id", async () => {
    mocks.getProviderCredentials.mockResolvedValue({ noActiveCredentials: true, candidate: { status: 503, message: "No active credentials for provider: red-router" } });

    const response = await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13"));

    expect(response.status).toBe(503);
    expect(received).toHaveLength(0);
  });
});

describe("loop protection", () => {
  it("rejects a request that already passed through this router", async () => {
    const response = await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13", {
      [RED_ROUTER_CHAIN_HEADER]: `rr-edge,${RED_ROUTER_INSTANCE_ID}`,
    }));

    expect(response.status).toBe(508);
    expect((await response.json()).error.message).toContain("RedRouter routing loop detected");
    expect(received).toHaveLength(0);
  });

  it("rejects a chain that comes back to this router through the upstream one", async () => {
    // The upstream router is this very router: it sees itself in the chain.
    reply = ({ req, raw }) => handleSystemOne(new Request("http://router.test/v1/systemone", {
      method: "POST",
      headers: {
        authorization: req.headers.authorization,
        "content-type": "application/json",
        [RED_ROUTER_CHAIN_HEADER]: req.headers[RED_ROUTER_CHAIN_HEADER],
      },
      body: raw,
    }));

    const response = await handleSystemOne(makeRequest("red-router/red-router/opencode-zen/jev-1.13"));

    expect(response.status).toBe(508);
    const message = (await response.json()).error.message;
    expect(message).toContain('RedRouter "Home router" answered HTTP 508');
    expect(message).toContain("RedRouter routing loop detected");
    expect(received).toHaveLength(1);
  });

  it(`stops at ${RED_ROUTER_MAX_HOPS} router hops`, async () => {
    const full = Array.from({ length: RED_ROUTER_MAX_HOPS }, (_, i) => `rr-${i}`).join(",");

    const response = await handleSystemOne(makeRequest("red-router/opencode-zen/jev-1.13", { [RED_ROUTER_CHAIN_HEADER]: full }));

    expect(response.status).toBe(508);
    expect((await response.json()).error.message).toContain(`RedRouter hop limit exceeded (${RED_ROUTER_MAX_HOPS})`);
    expect(received).toHaveLength(0);
  });
});
