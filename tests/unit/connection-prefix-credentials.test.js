// A connection model prefix pins credential selection to the accounts carrying it:
// "codex-work/<model>" never falls back to the Codex account behind "codex-home/".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProviderConnections, getSettings } = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyAllowedConnectionIds: vi.fn(async () => null),
  getApiKeyOwner: vi.fn(async () => null),
  getProviderConnections,
  getProxyPools: vi.fn(),
  getSettings,
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const account = (id, priority) => ({
  id,
  provider: "codex",
  authType: "oauth",
  accessToken: `token-${id}`,
  isActive: true,
  priority,
  providerSpecificData: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getProviderConnections.mockResolvedValue([account("cx-home", 1), account("cx-work", 2)]);
});

describe("getProviderCredentials with connectionIds", () => {
  it("picks the pinned account even when another has priority", async () => {
    const credentials = await getProviderCredentials("codex", null, "gpt-5.5", { connectionIds: ["cx-work"] });
    expect(credentials.connectionId).toBe("cx-work");
  });

  it("does not fall back to an account outside the pin", async () => {
    const credentials = await getProviderCredentials("codex", new Set(["cx-work"]), "gpt-5.5", { connectionIds: ["cx-work"] });
    expect(credentials.noActiveCredentials).toBe(true);
  });

  it("keeps the whole pool without a pin", async () => {
    const credentials = await getProviderCredentials("codex", new Set(["cx-home"]), "gpt-5.5", {});
    expect(credentials.connectionId).toBe("cx-work");
  });
});
