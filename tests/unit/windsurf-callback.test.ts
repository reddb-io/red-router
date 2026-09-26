import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseWindsurfCallback } from "../../src/lib/oauth/utils/windsurfCallback.ts";

const redirectUri = "http://127.0.0.1:20128/windsurf-auth-callback";
const callback = `${redirectUri}?access_token=eyJ.test.signature&state=expected`;

test("Windsurf manual callback accepts one token and the matching state", () => {
  assert.deepEqual(parseWindsurfCallback(callback, redirectUri, "expected"), {
    ok: true,
    token: "eyJ.test.signature",
    state: "expected",
  });
});

test("Windsurf manual callback rejects missing or duplicate credentials and state", () => {
  assert.deepEqual(parseWindsurfCallback(redirectUri, redirectUri, "expected"), {
    ok: false,
    reason: "missing_token",
  });
  assert.deepEqual(
    parseWindsurfCallback(`${callback}&access_token=other`, redirectUri, "expected"),
    {
      ok: false,
      reason: "missing_token",
    }
  );
  assert.deepEqual(parseWindsurfCallback(`${callback}&state=other`, redirectUri, "expected"), {
    ok: false,
    reason: "state_mismatch",
  });
  assert.deepEqual(parseWindsurfCallback(callback, redirectUri, "different"), {
    ok: false,
    reason: "state_mismatch",
  });
});

test("Windsurf manual callback is bound to the issued redirect URI", () => {
  for (const url of [
    callback.replace("127.0.0.1", "evil.example"),
    callback.replace("20128", "20129"),
    callback.replace("windsurf-auth-callback", "callback"),
    `${callback}#access_token=other`,
    "not-a-url",
  ]) {
    assert.deepEqual(parseWindsurfCallback(url, redirectUri, "expected"), {
      ok: false,
      reason: "invalid_callback",
    });
  }
});

test("OAuthModal selects callback polling locally and safe manual parsing remotely", () => {
  const source = readFileSync("src/shared/components/OAuthModal.tsx", "utf8");
  assert.match(source, /PKCE_CALLBACK_SERVER_PROVIDERS = new Set\(\[[\s\S]*?"windsurf"/);
  assert.match(source, /redirectUri = "http:\/\/127\.0\.0\.1:20128\/windsurf-auth-callback"/);
  assert.match(source, /parseWindsurfCallback\(input, authData\.redirectUri, authData\.state\)/);
  assert.match(source, /callback\.ok === false && callback\.reason === "state_mismatch"/);
  assert.match(source, /await exchangeTokens\(callback\.token, callback\.state\)/);
});
