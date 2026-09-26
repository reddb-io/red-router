import assert from "node:assert/strict";
import test from "node:test";

import { validateQoderCnProvider } from "../../src/lib/providers/validation/qoderCn.ts";
import { clearQoderCnModelCacheForTest } from "../../open-sse/services/qoderCnModels.ts";

test("Qoder CN validates a device token against its authenticated China catalog", async () => {
  clearQoderCnModelCacheForTest();
  const urls: string[] = [];
  const result = await validateQoderCnProvider({
    apiKey: "dt-cn-token",
    providerSpecificData: { userId: "cn-user" },
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(new URL(url).host, "gateway.qoder.com.cn");
      assert.match((init.headers as Record<string, string>).Authorization, /^Bearer COSY\./);
      return Response.json({ chat: [{ key: "auto" }] });
    },
  });
  assert.deepEqual(result, { valid: true, error: null, unsupported: false });
  assert.equal(urls.length, 1);
});

test("Qoder CN never marks an unavailable or malformed catalog as valid", async () => {
  clearQoderCnModelCacheForTest();
  const unavailable = await validateQoderCnProvider({
    apiKey: "dt-cn-token",
    providerSpecificData: { userId: "cn-user" },
    fetchImpl: async () => new Response("secret at /srv/private", { status: 503 }),
  });
  assert.equal(unavailable.valid, false);
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(unavailable.error || "", /secret|srv/);

  const missingUser = await validateQoderCnProvider({ apiKey: "dt-cn-token" });
  assert.equal(missingUser.valid, false);
  assert.equal(missingUser.statusCode, 401);
  const wrongToken = await validateQoderCnProvider({ apiKey: "sk-global-token" });
  assert.equal(wrongToken.valid, false);
  assert.equal(wrongToken.statusCode, 400);
});

test("Qoder CN validation preserves authentication, quota and service failure status", async () => {
  for (const status of [401, 403, 429, 503]) {
    clearQoderCnModelCacheForTest();
    const result = await validateQoderCnProvider({
      apiKey: "dt-cn-token",
      providerSpecificData: { userId: "cn-user" },
      fetchImpl: async () => new Response("private upstream detail at /srv/private", { status }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.statusCode, status);
    assert.doesNotMatch(result.error || "", /private|srv/);
  }
});

test("Qoder CN PAT failures retain their status without leaking provider responses", async () => {
  for (const status of [401, 429]) {
    const result = await validateQoderCnProvider({
      apiKey: `pt-cn-token-${status}`,
      fetchImpl: async () => new Response("private PAT detail at /srv/private", { status }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.statusCode, status);
    assert.doesNotMatch(result.error || "", /private|srv/);
  }
});
