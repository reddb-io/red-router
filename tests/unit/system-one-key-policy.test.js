// /v1/systemone holds the calling key to the same limits and model rules as chat;
// the router's own classifier call (internal token) is exempt, since its parent
// request already passed them.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleSystemOneCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: vi.fn(async () => true),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: true }), getApiKeyOwner: async () => null, getComboByName: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("open-sse/handlers/systemOneCore.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, handleSystemOneCore: mocks.handleSystemOneCore };
});
vi.mock("@/sse/utils/logger.js", () => ({ request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

let handleSystemOne;
let internalCallHeaders;
let repo;
let resetApiKeyLimits;

beforeAll(async () => {
  ({ handleSystemOne } = await import("../../src/sse/handlers/systemOne.js"));
  ({ internalCallHeaders } = await import("../../src/sse/services/internalCall.js"));
  ({ resetApiKeyLimits } = await import("@/lib/apiKeyLimits.js"));
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  resetApiKeyLimits();
  mocks.getProviderCredentials.mockResolvedValue({ apiKey: "stored", connectionId: "c1", connectionName: "c1", providerSpecificData: {} });
  mocks.handleSystemOneCore.mockResolvedValue({ success: true, status: 200, usage: null, response: Response.json({ answers: {} }) });
});

async function keyWith(update) {
  const key = await repo.createApiKey("s1", "m1");
  await repo.updateApiKey(key.id, update);
  return key.key;
}

function call(key, extraHeaders = {}) {
  return handleSystemOne(new Request("http://router.test/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ model: "jev-latest", state: "x", questions: { q: { type: "noul", instructions: "?" } } }),
  }));
}

describe("/v1/systemone key policy", () => {
  it("denies a model outside the key's allow list", async () => {
    const key = await keyWith({ modelAccess: { mode: "allow", patterns: ["openai/*"] } });
    const res = await call(key);
    expect(res.status).toBe(403);
    expect(res.headers.get("X-9Router-Reason")).toBe("model_not_allowed");
    expect(mocks.handleSystemOneCore).not.toHaveBeenCalled();
  });

  it("applies the key's rpm limit", async () => {
    const key = await keyWith({ limits: { rpm: 1 } });
    expect((await call(key)).status).toBe(200);
    const limited = await call(key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-9Router-Reason")).toBe("api_key_limit");
  });

  it("lets the router's own classifier call through both checks", async () => {
    const key = await keyWith({ modelAccess: { mode: "allow", patterns: ["openai/*"] }, limits: { rpm: 1 } });
    expect((await call(key, internalCallHeaders())).status).toBe(200);
    expect((await call(key, internalCallHeaders())).status).toBe(200);
  });

  it("does not trust a forged internal header", async () => {
    const key = await keyWith({ modelAccess: { mode: "allow", patterns: ["openai/*"] } });
    expect((await call(key, { "x-red-router-internal": "guess" })).status).toBe(403);
  });
});
