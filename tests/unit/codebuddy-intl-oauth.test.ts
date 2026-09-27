import assert from "node:assert/strict";
import test from "node:test";

import { CODEBUDDY_INTL_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { codebuddyIntl } from "../../src/lib/oauth/providers/codebuddy-intl.ts";
import { refreshCodebuddyIntlToken } from "../../open-sse/services/tokenRefresh/providers/codebuddyIntl.ts";

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("CodeBuddy Intl device login stays on the .ai host with IDE identity", async () => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://www.codebuddy.ai/v2/plugin/auth/state?platform=ide");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.equal((init?.headers as Record<string, string>)["X-Domain"], "www.codebuddy.ai");
    return Response.json({
      code: 0,
      data: {
        state: "intl-state-1",
        authUrl: "https://www.codebuddy.ai/v2/plugin/auth/authorize?state=intl-state-1",
      },
    });
  }) as typeof fetch;

  const device = await codebuddyIntl.requestDeviceCode(CODEBUDDY_INTL_CONFIG);
  assert.equal(device.device_code, "intl-state-1");
  assert.equal(device.user_code, "");
  assert.match(device.verification_uri, /^https:\/\/www\.codebuddy\.ai\//);
  assert.equal(device.interval, 5);
});

test("CodeBuddy Intl rejects a provider-supplied authorization URL outside its domain", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      code: 0,
      data: { state: "safe-state", authUrl: "https://codebuddy.ai.evil.example/steal" },
    })) as typeof fetch;
  await assert.rejects(
    codebuddyIntl.requestDeviceCode(CODEBUDDY_INTL_CONFIG),
    /untrusted authorization URL/
  );
});

test("CodeBuddy Intl polling distinguishes pending from tokens and encodes state", async () => {
  const urls: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>)["X-Domain"], "www.codebuddy.ai");
    calls++;
    return Response.json(
      calls === 1
        ? { code: 11217 }
        : {
            code: 0,
            data: {
              accessToken: "intl-access",
              refreshToken: "intl-refresh",
              expiresIn: 3600,
            },
          }
    );
  }) as typeof fetch;

  const pending = await codebuddyIntl.pollToken(CODEBUDDY_INTL_CONFIG, "state with space");
  assert.deepEqual(pending, { ok: true, data: { error: "authorization_pending" } });
  const success = await codebuddyIntl.pollToken(CODEBUDDY_INTL_CONFIG, "state with space");
  assert.equal(success.ok, true);
  assert.ok("access_token" in success.data);
  assert.deepEqual(codebuddyIntl.mapTokens(success.data), {
    accessToken: "intl-access",
    refreshToken: "intl-refresh",
    expiresIn: 3600,
    providerSpecificData: {},
  });
  assert.deepEqual(urls, [
    "https://www.codebuddy.ai/v2/plugin/auth/token?state=state+with+space",
    "https://www.codebuddy.ai/v2/plugin/auth/token?state=state+with+space",
  ]);
});

test("CodeBuddy Intl refresh never sends its token to the CN host", async () => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), CODEBUDDY_INTL_CONFIG.refreshUrl);
    assert.equal((init?.headers as Record<string, string>)["X-Refresh-Token"], "old-refresh");
    assert.equal((init?.headers as Record<string, string>)["X-Domain"], "www.codebuddy.ai");
    return Response.json({
      code: 0,
      data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 7200 },
    });
  }) as typeof fetch;

  assert.deepEqual(await refreshCodebuddyIntlToken("old-refresh", null), {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresIn: 7200,
  });
});
