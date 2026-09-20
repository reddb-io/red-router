import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleSystemOneCore: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  saveRequestUsage: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: mocks.clearAccountError,
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
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

function makeRequest() {
  return new Request("http://router.test/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: "Bearer router-client-key",
      "Content-Type": "application/json",
      "x-connection-id": "typesafe-connection",
    },
    body: JSON.stringify({
      state: "Ship the incident fix now",
      model: "jev/jev-latest",
      questions: { urgency: { type: "noul", instructions: "Is it urgent?" } },
    }),
  });
}

describe("System One app handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "stored-typesafe-key",
      connectionId: "typesafe-connection",
      connectionName: "TypeSafe production",
      providerSpecificData: {},
    });
    mocks.clearAccountError.mockResolvedValue(undefined);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.saveRequestUsage.mockResolvedValue(undefined);
    mocks.handleSystemOneCore.mockResolvedValue({
      success: true,
      status: 200,
      usage: { input_tokens: 12, output_tokens: 3 },
      response: Response.json({ answers: {} }),
    });
  });

  it("authenticates the router key but sends the stored TypeSafe credential", async () => {
    const response = await handleSystemOne(makeRequest());

    expect(response.status).toBe(200);
    expect(mocks.isValidApiKey).toHaveBeenCalledWith("router-client-key");
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "typesafe-ai",
      expect.any(Set),
      "jev-latest",
      { apiKey: "router-client-key", preferredConnectionId: "typesafe-connection" },
    );
    expect(mocks.handleSystemOneCore).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ apiKey: "stored-typesafe-key" }),
      body: expect.objectContaining({ model: "jev-latest" }),
    }));
  });

  it("records exact JEV token usage", async () => {
    await handleSystemOne(makeRequest());
    await vi.waitFor(() => expect(mocks.saveRequestUsage).toHaveBeenCalledOnce());

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "typesafe-ai",
      model: "jev-latest",
      connectionId: "typesafe-connection",
      apiKey: "router-client-key",
      endpoint: "/v1/systemone",
      tokens: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }));
  });

  it("returns the last native 429 response after exhausting account fallback", async () => {
    const upstreamBody = { error: { message: "rate limited" } };
    mocks.handleSystemOneCore.mockResolvedValueOnce({
      success: false,
      status: 429,
      error: "rate limited",
      resetsAtMs: Date.now() + 17000,
      response: Response.json(upstreamBody, { status: 429, headers: { "Retry-After": "17" } }),
    });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "stored-typesafe-key",
        connectionId: "typesafe-connection",
        connectionName: "TypeSafe production",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        allRateLimited: true,
        candidate: { status: 429, message: "locked", provider: "typesafe-ai", model: "jev-latest" },
      });

    const response = await handleSystemOne(makeRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toEqual(upstreamBody);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "typesafe-connection",
      429,
      "rate limited",
      "typesafe-ai",
      "jev-latest",
      expect.any(Number),
    );
  });
});
