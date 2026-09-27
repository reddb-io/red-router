import assert from "node:assert/strict";
import test from "node:test";

import { getQoderCnUsage, parseQoderCnQuota } from "../../open-sse/services/qoderCnQuota.ts";
import { clearQoderCnPatCacheForTest } from "../../open-sse/services/qoderCnPat.ts";

test("Qoder CN parses only present quota records and keeps the reset timestamp", () => {
  const parsed = parseQoderCnQuota({
    userQuota: { total: 100, used: 25, remaining: 75, unit: "credits" },
    expiresAt: 1_800_000_000_000,
    totalUsagePercentage: 25,
    isQuotaExceeded: false,
  });
  assert.equal(parsed?.quotas.user.remainingPercentage, 75);
  assert.equal(parsed?.quotas.user.resetAt, new Date(1_800_000_000_000).toISOString());
  assert.equal(parsed?.quotas.organization, undefined);
  assert.equal(parsed?.totalUsagePercentage, 25);
  assert.equal(parseQoderCnQuota({ userQuota: { used: 3 } }), null);
  assert.equal(
    parseQoderCnQuota({ userQuota: { total: 0, used: 0, remaining: 0 } }),
    null
  );
});

test("Qoder CN treats explicit exhaustion as zero but does not invent exhaustion", () => {
  assert.equal(
    parseQoderCnQuota({
      userQuota: { total: 0, used: 0, remaining: 0 },
      isQuotaExceeded: false,
    })?.quotas.user.remainingPercentage,
    100
  );
  assert.equal(
    parseQoderCnQuota({
      userQuota: { total: 10, used: 10, remaining: 1 },
      isQuotaExceeded: true,
    })?.quotas.user.remainingPercentage,
    0
  );
});

test("Qoder CN exchanges a PAT before reading only the China quota endpoint", async () => {
  clearQoderCnPatCacheForTest();
  const urls: string[] = [];
  const quota = await getQoderCnUsage("pt-cn-secret", {
    fetchImpl: async (url, init) => {
      urls.push(url);
      if (url.endsWith("/jobToken/exchange")) {
        assert.match(String(init.body), /pt-cn-secret/);
        return Response.json({ token: "jt-cn-resolved" });
      }
      if (url.endsWith("/userinfo")) return Response.json({ id: "cn-user" });
      assert.equal(new URL(url).host, "openapi.qoder.com.cn");
      assert.equal(new URL(url).pathname, "/api/v2/quota/usage");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer jt-cn-resolved");
      return Response.json({ userQuota: { total: 20, used: 5, remaining: 15 } });
    },
  });
  assert.equal(urls.length, 3);
  assert.ok("quotas" in quota);
  if ("quotas" in quota) assert.equal(quota.quotas.user.remainingPercentage, 75);
});

test("Qoder CN does not expose quota response bodies or guess missing values", async () => {
  const failed = await getQoderCnUsage("dt-cn-token", {
    fetchImpl: async () => new Response("secret at /srv/private", { status: 403 }),
  });
  assert.deepEqual(failed, { message: "Qoder CN usage API returned HTTP 403" });
  const empty = await getQoderCnUsage("dt-cn-token", {
    fetchImpl: async () => Response.json({ unexpected: true }),
  });
  assert.deepEqual(empty, { message: "Qoder CN usage response has no usable quota records" });
});
