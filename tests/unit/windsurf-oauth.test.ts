import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublicCred } from "../../open-sse/utils/publicCreds.ts";
import { exchangeTokens, generateAuthData, getProvider } from "../../src/lib/oauth/providers.ts";
import { startLocalServer } from "../../src/lib/oauth/utils/server.ts";
import { supportsDualAuthProvider } from "../../src/shared/constants/providers.ts";
import { POST as oauthPost } from "../../src/app/api/oauth/[provider]/[action]/route.ts";

test("Windsurf browser auth preserves the loopback callback and CSRF state", () => {
  const redirectUri = "http://127.0.0.1:12345/windsurf-auth-callback";
  const data = generateAuthData("windsurf", redirectUri);
  const url = new URL(data.authUrl);
  assert.equal(url.origin, "https://www.windsurf.com");
  assert.equal(url.pathname, "/windsurf/signin");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("state"), data.state);
  assert.equal(url.searchParams.get("client_id"), resolvePublicCred("windsurf_id"));
  assert.equal(supportsDualAuthProvider("windsurf"), true);
});

test("Windsurf Firebase token is exchanged for a separate Codeium API key", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ apiKey: "sk-ws-exchanged", name: "Windsurf User" });
  };
  try {
    const result = await exchangeTokens(
      "windsurf",
      "eyJ.firebase-token.signature",
      "",
      "",
      "state"
    );
    assert.equal(result.accessToken, "sk-ws-exchanged");
    assert.equal(result.displayName, "Windsurf User");
    assert.equal(result.providerSpecificData.authMethod, "oauth");
    assert.equal(result.providerSpecificData.firebaseIdToken, undefined);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser"
    );
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      firebase_id_token: "eyJ.firebase-token.signature",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf direct key import avoids RegisterUser and rejects malformed tokens", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("RegisterUser must not be called");
  };
  try {
    const imported = await exchangeTokens("windsurf", "sk-ws-direct", "", "", "state");
    assert.equal(imported.accessToken, "sk-ws-direct");
    assert.equal(imported.providerSpecificData.authMethod, "imported");
    await assert.rejects(() => exchangeTokens("windsurf", "not-a-token", "", "", "state"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf RegisterUser errors never echo Firebase tokens or upstream bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("eyJ.private-token at /srv/secrets/file.ts", { status: 401 });
  try {
    await assert.rejects(
      () => exchangeTokens("windsurf", "eyJ.private-token.signature", "", "", "state"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /private-token|\/srv\/secrets/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf callback server binds loopback and accepts the configured path", async () => {
  let received: Record<string, string> | undefined;
  const callback = await startLocalServer(
    (params) => {
      received = params;
    },
    null,
    { callbackPath: "/windsurf-auth-callback", listenHost: "127.0.0.1" }
  );
  try {
    assert.equal(callback.server.address().address, "127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${callback.port}/windsurf-auth-callback?access_token=token&state=good`
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(received?.access_token, "token");
    assert.equal(received?.state, "good");
  } finally {
    callback.close();
  }
});

test("Windsurf and Devin Desktop OAuth handlers are separate", () => {
  assert.notEqual(getProvider("windsurf"), getProvider("devin-desktop"));
  assert.equal(getProvider("devin-desktop").flowType, "import_token");
});

test("Windsurf callback polling rejects missing tokens and mismatched state", async () => {
  const previous = globalThis.__pkceCallbackStates;
  const request = new Request("http://localhost:20128/api/oauth/windsurf/poll-callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const context = {
    params: Promise.resolve({ provider: "windsurf", action: "poll-callback" }),
  } as never;
  try {
    globalThis.__pkceCallbackStates = {
      windsurf: {
        callbackParams: { state: "right" },
        redirectUri: "http://127.0.0.1:12345/windsurf-auth-callback",
        codeVerifier: "unused",
        state: "right",
        close() {},
      },
    };
    const missing = await oauthPost(request.clone(), context);
    assert.equal((await missing.json()).error, "no_token");

    globalThis.__pkceCallbackStates.windsurf = {
      callbackParams: { access_token: "eyJ.private-token", state: "wrong" },
      redirectUri: "http://127.0.0.1:12345/windsurf-auth-callback",
      codeVerifier: "unused",
      state: "right",
      close() {},
    };
    const mismatch = await oauthPost(request.clone(), context);
    assert.equal((await mismatch.json()).error, "invalid_state");
  } finally {
    globalThis.__pkceCallbackStates = previous;
  }
});
