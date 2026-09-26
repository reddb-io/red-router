// #8408: Guard against missing OAUTH_TEST_CONFIG entries for OAuth providers
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers/oauth.ts";
import { OAUTH_TEST_CONFIG } from "../../src/app/api/providers/[id]/test/oauthTestConfig.ts";

// NOT a design decision — this is a grandfathered backlog. These four ids are simply the
// providers that still lack an OAUTH_TEST_CONFIG entry today, captured so this guard can be
// enforced from now on without a big-bang change. Each one is a candidate for the same
// treatment devin-cli and agy get here; removing an id from this list is the fix, not a
// regression. Do not add new ids to it — a provider added without a test config should fail
// this test at the time it is added, which is the entire point.
const GRANDFATHERED_WITHOUT_TEST_CONFIG = new Set(["qoder", "zed", "zed-hosted", "trae"]);

test("#8408: devin-cli and agy are present in OAUTH_TEST_CONFIG", () => {
  assert.ok(
    (OAUTH_TEST_CONFIG as Record<string, unknown>)["devin-cli"],
    "devin-cli must have an entry in OAUTH_TEST_CONFIG"
  );
  assert.ok(
    (OAUTH_TEST_CONFIG as Record<string, unknown>)["agy"],
    "agy must have an entry in OAUTH_TEST_CONFIG"
  );
});

test("devin-desktop connection test is import-only and not refreshable (#8228)", () => {
  const config = (OAUTH_TEST_CONFIG as Record<string, { refreshable?: boolean }>)["devin-desktop"];
  assert.ok(config, "devin-desktop must have an OAuth test config");
  assert.equal(config.refreshable, false);
});

test("Windsurf OAuth stores a long-lived Codeium key without a refresh token", () => {
  const config = (OAUTH_TEST_CONFIG as Record<string, { refreshable?: boolean }>).windsurf;
  assert.ok(config);
  assert.equal(config.refreshable, false);
});

test("Kimchi connection probe checks its bearer-key model catalog", () => {
  const config = OAUTH_TEST_CONFIG.kimchi;
  assert.equal(config.url, "https://llm.kimchi.dev/v1/models");
  assert.equal(config.method, "GET");
  assert.equal(config.authHeader, "Authorization");
  assert.equal(config.authPrefix, "Bearer ");
  assert.equal(config.refreshable, false);
});

test("iFlow connection probe signs the actual chat request with the credential", async () => {
  const config = OAUTH_TEST_CONFIG.iflow;
  assert.equal(config.refreshable, false);
  assert.ok(config.buildProbe);
  const probe = await config.buildProbe({}, "test-iflow-token");
  assert.equal(probe.url, "https://apis.iflow.cn/v1/chat/completions");
  assert.equal(probe.method, "POST");
  assert.equal(probe.headers.Authorization, "Bearer test-iflow-token");
  assert.equal(probe.headers.Accept, "application/json");
  const sessionId = probe.headers["session-id"];
  const timestamp = probe.headers["x-iflow-timestamp"];
  assert.match(sessionId, /^session-[0-9a-f-]+$/);
  assert.match(timestamp, /^\d+$/);
  const expectedSignature = createHmac("sha256", "test-iflow-token")
    .update(`${probe.headers["User-Agent"]}:${sessionId}:${timestamp}`)
    .digest("hex");
  assert.equal(probe.headers["x-iflow-signature"], expectedSignature);
  assert.deepEqual(JSON.parse(probe.body || ""), {
    model: "qwen3-coder-plus",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
});

test("#8408: every OAuth provider ID has an OAUTH_TEST_CONFIG entry (or is grandfathered)", () => {
  const providerIds = Object.keys(OAUTH_PROVIDERS);
  const testConfigKeys = new Set(Object.keys(OAUTH_TEST_CONFIG));

  for (const providerId of providerIds) {
    const isCovered =
      testConfigKeys.has(providerId) || GRANDFATHERED_WITHOUT_TEST_CONFIG.has(providerId);
    assert.ok(
      isCovered,
      `OAuth provider '${providerId}' must have an entry in OAUTH_TEST_CONFIG. ` +
        'Without one, Test Connection persists testStatus="error" on a healthy account (#8408).'
    );
  }
});
