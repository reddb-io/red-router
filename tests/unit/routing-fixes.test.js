// PR "routing & security": model-scoped errors move a combo on; a 5xx blip locks
// briefly while streaks escalate; jev's pool keeps only members with a usable
// account; a subscription member costs nothing extra.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(),
  getApiKeyOwner: vi.fn(),
  updateProviderConnection: vi.fn(),
  getModelInfo: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getApiKeyAllowedConnectionIds: mocks.getApiKeyAllowedConnectionIds,
  getApiKeyOwner: mocks.getApiKeyOwner,
  updateProviderConnection: mocks.updateProviderConnection,
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(async () => true),
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { isModelScopedError } = await import("../../open-sse/services/accountFallback.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { errorResponse } = await import("../../open-sse/utils/error.js");
const { markAccountUnavailable } = await import("@/sse/services/auth.js");
const { resetProviderHealth, recordSuccess } = await import("../../open-sse/services/providerHealth.js");
const { memberUsable } = await import("@/sse/services/memberEligibility.js");
const { requestCostOf } = await import("@/sse/services/decisionRouter.js");

const log = { info() {}, warn() {}, debug() {} };

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderHealth();
  mocks.getSettings.mockResolvedValue({});
  mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
  mocks.getApiKeyOwner.mockResolvedValue(null);
  mocks.updateProviderConnection.mockResolvedValue({});
});

describe("model-scoped errors", () => {
  it("recognizes a missing, retired or unsupported model, but not a bad request", () => {
    expect(isModelScopedError(410, "gone")).toBe(true);
    expect(isModelScopedError(400, "[400]: The requested model is not supported")).toBe(true);
    expect(isModelScopedError(400, "model_not_found: gpt-9 does not exist")).toBe(true);
    expect(isModelScopedError(404, "Model claude-2 has been deprecated")).toBe(true);
    expect(isModelScopedError(400, "This model does not support assistant message prefill")).toBe(false);
    expect(isModelScopedError(400, "Unsupported parameter: 'max_tokens' is not supported with this model")).toBe(false);
    expect(isModelScopedError(400, "prompt is too long")).toBe(false);
    expect(isModelScopedError(500, "model not found")).toBe(false);
  });

  it("move a combo to its next member instead of ending it", async () => {
    const calls = [];
    const ok = new Response("{}", { status: 200 });
    const result = await handleComboChat({
      body: {}, models: ["p/retired", "p/good"], log, comboName: "scoped",
      handleSingleModel: async (_b, m) => {
        calls.push(m);
        return m === "p/retired" ? errorResponse(400, "The requested model is not supported") : ok;
      },
    });
    expect(calls).toEqual(["p/retired", "p/good"]);
    expect(result).toBe(ok);
  });

  it("still end the combo on a request error every member would repeat", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: {}, models: ["p/a", "p/b"], log, comboName: "request-error",
      handleSingleModel: async (_b, m) => { calls.push(m); return errorResponse(400, "prompt is too long"); },
    });
    expect(calls).toEqual(["p/a"]);
    expect(result.status).toBe(400);
  });
});

describe("cooldowns", () => {
  const conn = (extra = {}) => ({ id: "a1", provider: "openai", isActive: true, backoffLevel: 0, ...extra });

  it("a 5xx right after a success locks briefly; a repeat locks for the full transient cooldown", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn()]);
    recordSuccess({ connectionId: "a1", model: "gpt-5" });
    const first = await markAccountUnavailable("a1", 503, "upstream down", "openai", "gpt-5");
    expect(first).toMatchObject({ shouldFallback: true, cooldownMs: 5000 });
    const second = await markAccountUnavailable("a1", 503, "upstream down", "openai", "gpt-5");
    expect(second.cooldownMs).toBe(30_000);
  });

  it("a 429 streak escalates with the account's backoff level", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn({ backoffLevel: 0 })]);
    const first = await markAccountUnavailable("a1", 429, "rate limit", "openai", "gpt-5");
    mocks.getProviderConnections.mockResolvedValue([conn({ backoffLevel: 3 })]);
    const later = await markAccountUnavailable("a1", 429, "rate limit", "openai", "gpt-5");
    expect(later.cooldownMs).toBeGreaterThan(first.cooldownMs);
  });

  it("an upstream reset time still wins", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn({ backoffLevel: 5 })]);
    const reset = Date.now() + 120_000;
    const out = await markAccountUnavailable("a1", 429, "rate limit", "openai", "gpt-5", reset);
    expect(out.cooldownMs).toBeGreaterThan(100_000);
    expect(out.cooldownMs).toBeLessThanOrEqual(120_000);
  });
});

describe("member eligibility", () => {
  const future = new Date(Date.now() + 600_000).toISOString();

  it("a member whose only account is locked for the model is not usable", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5" });
    mocks.getProviderConnections.mockResolvedValue([{ id: "a1", provider: "openai", isActive: true, "modelLock_gpt-5": future }]);
    expect(await memberUsable("openai/gpt-5")).toBe(false);
    mocks.getProviderConnections.mockResolvedValue([{ id: "a1", provider: "openai", isActive: true }]);
    expect(await memberUsable("openai/gpt-5")).toBe(true);
  });

  it("respects the key's bound accounts and connection-prefix pinning", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5" });
    mocks.getProviderConnections.mockResolvedValue([{ id: "a1", provider: "openai", isActive: true }]);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(["other"]);
    expect(await memberUsable("openai/gpt-5", { apiKey: "sk-x" })).toBe(false);
    mocks.getApiKeyAllowedConnectionIds.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5", connectionIds: ["b2"] });
    expect(await memberUsable("work/gpt-5")).toBe(false);
  });

  it("keeps members it cannot judge (nested combos, errors)", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: null });
    expect(await memberUsable("tier-fast")).toBe(true);
    mocks.getModelInfo.mockRejectedValue(new Error("db down"));
    expect(await memberUsable("openai/gpt-5")).toBe(true);
  });
});

describe("request cost", () => {
  it("is zero on a subscription account, priced on an API key", () => {
    const cost = requestCostOf({ messages: [{ role: "user", content: "hi" }] }, { inputTokens: 1000 });
    expect(cost("cc/claude-sonnet-4-6")).toBe(0);
    expect(cost("anthropic/claude-sonnet-4-6")).toBeGreaterThan(0);
  });
});
