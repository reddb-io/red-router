import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exchangeKimiRefreshToken } from "../../src/lib/kimi/tokenRefresh.ts";
import { getKimiWebBaseUrl } from "../../src/lib/kimi/baseUrl.ts";

describe("Kimi Token Refresh Exchange", () => {
  it("normalizes the default and configured Web host", () => {
    const previous = process.env.KIMI_WEB_BASE_URL;
    try {
      delete process.env.KIMI_WEB_BASE_URL;
      assert.equal(getKimiWebBaseUrl(), "https://www.kimi.ai");
      process.env.KIMI_WEB_BASE_URL = "https://kimi.example.test///";
      assert.equal(getKimiWebBaseUrl(), "https://kimi.example.test");
    } finally {
      if (previous === undefined) delete process.env.KIMI_WEB_BASE_URL;
      else process.env.KIMI_WEB_BASE_URL = previous;
    }
  });

  it("exchanges valid refresh_token for new access_token and refresh_token", async () => {
    const originalFetch = globalThis.fetch;
    const now = Math.floor(Date.now() / 1000);
    const mockNewAccessToken =
      "eyJhbGciOiJIUzUxMiJ9." +
      Buffer.from(JSON.stringify({ exp: now + 86400 * 30, iat: now })).toString("base64url") +
      ".sig";
    const mockNewRefreshToken =
      "eyJhbGciOiJIUzUxMiJ9." +
      Buffer.from(JSON.stringify({ exp: now + 86400 * 90, iat: now })).toString("base64url") +
      ".sig";

    try {
      globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(String(url), "https://www.kimi.ai/api/auth/token/refresh");
        assert.equal(init?.headers?.["Authorization"], "Bearer sample_refresh_token");
        return new Response(
          JSON.stringify({
            access_token: mockNewAccessToken,
            refresh_token: mockNewRefreshToken,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      const res = await exchangeKimiRefreshToken("sample_refresh_token", "https://www.kimi.ai");
      assert.equal(res.success, true);
      assert.equal(res.accessToken, mockNewAccessToken);
      assert.equal(res.refreshToken, mockNewRefreshToken);
      assert.ok(res.expiresAtSec! > now);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles upstream refresh failure cleanly", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ error_type: "auth.token.invalid" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const res = await exchangeKimiRefreshToken("expired_refresh_token", "https://www.kimi.ai");
      assert.equal(res.success, false);
      assert.ok(res.error?.includes("401"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
