import assert from "node:assert/strict";
import test from "node:test";

import { iflow } from "../../src/lib/oauth/providers/iflow.ts";
import { getProvider } from "../../src/lib/oauth/providers.ts";

test("iFlow browser login is registered with its phone authorization contract", () => {
  assert.equal(getProvider("iflow"), iflow);
  const url = new URL(
    iflow.buildAuthUrl(iflow.config, "http://127.0.0.1:56100/callback", "state-1")
  );
  assert.equal(url.origin, "https://iflow.cn");
  assert.equal(url.searchParams.get("loginMethod"), "phone");
  assert.equal(url.searchParams.get("type"), "phone");
  assert.equal(url.searchParams.get("redirect"), "http://127.0.0.1:56100/callback");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("client_id"), iflow.config.clientId);
});

test("iFlow exchanges a code, validates user info, and retains the inference API key", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init || {} });
    if (calls.length === 1) {
      return Response.json({
        access_token: "oauth-token",
        refresh_token: "refresh",
        expires_in: 3600,
      });
    }
    return Response.json({
      success: true,
      data: { apiKey: "inference-key", phone: "1234", nickname: "Test account" },
    });
  };
  try {
    const tokens = await iflow.exchangeToken(
      iflow.config,
      "auth-code",
      "http://localhost/callback"
    );
    const extra = await iflow.postExchange(tokens);
    assert.deepEqual(iflow.mapTokens(tokens, extra), {
      accessToken: "oauth-token",
      refreshToken: "refresh",
      expiresIn: 3600,
      apiKey: "inference-key",
      email: "1234",
      displayName: "Test account",
    });
    assert.equal(calls[0].url, iflow.config.tokenUrl);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(
      (calls[0].init.body as URLSearchParams).get("redirect_uri"),
      "http://localhost/callback"
    );
    assert.equal(new URL(calls[1].url).searchParams.get("accessToken"), "oauth-token");
    assert.equal(calls[1].init.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("iFlow rejects missing API keys and does not reflect upstream secret-bearing errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "secret=oauth-token" }, { status: 401 });
  try {
    await assert.rejects(
      iflow.exchangeToken(iflow.config, "auth-code", "http://localhost/callback"),
      (error: Error) => error.message === "iFlow token exchange failed (401)"
    );
    globalThis.fetch = async () =>
      Response.json({ success: true, data: { apiKey: "", email: "a@example.com" } });
    await assert.rejects(
      iflow.postExchange({ access_token: "oauth-token" }),
      (error: Error) => error.message === "iFlow returned invalid user info"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
