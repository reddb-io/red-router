// getProviderCredentials with the `health` strategy and quota-aware routing on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  getApiKeyAllowedConnectionIds: vi.fn(async () => null),
  getApiKeyOwner: vi.fn(async () => null),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");
const { recordSuccess, resetProviderHealth, getHealth } = await import("open-sse/services/providerHealth.js");
const { recordQuotaSnapshot, resetQuotaSnapshots } = await import("@/sse/services/quotaSnapshot.js");

const conn = (id, priority) => ({ id, provider: "openai", authType: "apikey", apiKey: `k-${id}`, isActive: true, priority });

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderHealth();
  resetQuotaSnapshots();
  mocks.getProviderConnections.mockResolvedValue([conn("first", 1), conn("second", 2)]);
});

describe("health strategy", () => {
  it("picks the faster account over the higher-priority one", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "health" });
    recordSuccess({ connectionId: "first", model: "gpt-5", ttftMs: 5000 });
    recordSuccess({ connectionId: "second", model: "gpt-5", ttftMs: 500 });
    vi.spyOn(Math, "random").mockReturnValue(0.99); // no exploration
    expect((await getProviderCredentials("openai", null, "gpt-5")).connectionId).toBe("second");
  });

  it("keeps fill-first unchanged when the strategy is not health", async () => {
    mocks.getSettings.mockResolvedValue({});
    recordSuccess({ connectionId: "first", model: "gpt-5", ttftMs: 5000 });
    recordSuccess({ connectionId: "second", model: "gpt-5", ttftMs: 500 });
    expect((await getProviderCredentials("openai", null, "gpt-5")).connectionId).toBe("first");
  });

  it("markAccountUnavailable counts a failure, but not a request-scoped 400", async () => {
    mocks.getSettings.mockResolvedValue({});
    await markAccountUnavailable("first", 400, "context length exceeded", "openai", "gpt-5");
    expect(getHealth("first", "gpt-5")).toBeNull();
    await markAccountUnavailable("first", 503, "upstream down", "openai", "gpt-5");
    expect(getHealth("first", "gpt-5")).toMatchObject({ samples: 1, errorRate: 0.3 });
  });
});

describe("quota-aware routing", () => {
  it("skips an account whose quota is used up when enabled", async () => {
    recordQuotaSnapshot("first", { quotas: { daily: { total: 10, used: 10 } } });
    mocks.getSettings.mockResolvedValue({ quotaAwareRouting: true });
    expect((await getProviderCredentials("openai", null, "gpt-5")).connectionId).toBe("second");
    mocks.getSettings.mockResolvedValue({});
    expect((await getProviderCredentials("openai", null, "gpt-5")).connectionId).toBe("first");
  });

  it("does not move a pinned connection", async () => {
    recordQuotaSnapshot("first", { quotas: { daily: { total: 10, used: 10 } } });
    mocks.getSettings.mockResolvedValue({ quotaAwareRouting: true });
    expect((await getProviderCredentials("openai", null, "gpt-5", { preferredConnectionId: "first" })).connectionId).toBe("first");
  });
});
