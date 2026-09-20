import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getProviderConnectionById: vi.fn(),
  testSingleConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
  getProviderConnectionById: mocks.getProviderConnectionById,
}));
vi.mock("@/lib/auth/resourceScope", () => ({
  canSee: vi.fn(() => true),
  getScopeFilter: vi.fn(async () => null),
  scopeVisible: vi.fn((items) => items),
}));
vi.mock("../../src/app/api/providers/[id]/test/testUtils.js", () => ({
  testSingleConnection: mocks.testSingleConnection,
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

const { POST } = await import("../../src/app/api/setup/validate/route.js");

function call(connectionId = "connection-1") {
  return POST(new Request("http://localhost/api/setup/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId }),
  }));
}

describe("setup validation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({ id: "connection-1", provider: "openai", name: "OpenAI", isActive: true });
    mocks.getApiKeys.mockResolvedValue([{ id: "key-1", isActive: true }]);
    mocks.testSingleConnection.mockResolvedValue({ valid: true });
  });

  it("reports ready only when server, provider and API key pass", async () => {
    const body = await (await call()).json();
    expect(body.status).toBe("ready");
    expect(body.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("requires an active API key", async () => {
    mocks.getApiKeys.mockResolvedValue([{ id: "key-1", isActive: false }]);
    const body = await (await call()).json();
    expect(body.status).toBe("action_required");
    expect(body.checks.find((check) => check.id === "apiKey").status).toBe("fail");
  });

  it("surfaces provider validation failure without exposing credentials", async () => {
    mocks.testSingleConnection.mockResolvedValue({ valid: false, error: "Token invalid or revoked" });
    const body = await (await call()).json();
    expect(body.status).toBe("action_required");
    expect(body.checks.find((check) => check.id === "provider").message).toBe("Token invalid or revoked");
  });
});
