import assert from "node:assert/strict";
import test from "node:test";

import {
  clearQoderCnPatCacheForTest,
  resolveQoderCnPat,
} from "../../open-sse/services/qoderCnPat.ts";

test("Qoder CN PAT exchanges only on CN endpoints and caches its job token", async () => {
  clearQoderCnPatCacheForTest();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("jobToken/exchange")) {
      return Response.json({ token: "jt-cn-token", expires_in: 3600 });
    }
    return Response.json({ id: "cn-user" });
  };
  try {
    const first = await resolveQoderCnPat("pt-cn-secret", { fetchImpl });
    const second = await resolveQoderCnPat("pt-cn-secret", { fetchImpl });
    assert.deepEqual(second, first);
    assert.equal(first.accessToken, "jt-cn-token");
    assert.equal(first.userId, "cn-user");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      personal_token: "pt-cn-secret",
    });
    assert.equal(calls[1].url, "https://openapi.qoder.com.cn/api/v1/userinfo");
    assert.equal(
      (calls[1].init.headers as Record<string, string>).Authorization,
      "Bearer jt-cn-token"
    );
  } finally {
    clearQoderCnPatCacheForTest();
  }
});

test("Qoder CN PAT exchange fails closed and does not echo provider bodies", async () => {
  clearQoderCnPatCacheForTest();
  const fetchImpl = async () => new Response("pt-secret at /srv/private", { status: 403 });
  await assert.rejects(
    () => resolveQoderCnPat("pt-cn-denied", { fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /pt-secret|\/srv\/private/);
      return true;
    }
  );
  clearQoderCnPatCacheForTest();
});

test("Qoder CN never returns the raw PAT if exchange is malformed", async () => {
  clearQoderCnPatCacheForTest();
  const fetchImpl = async () => Response.json({ token: "pt-not-a-job-token" });
  await assert.rejects(() => resolveQoderCnPat("pt-cn-invalid", { fetchImpl }), /job token/);
  clearQoderCnPatCacheForTest();
});

test("Qoder CN coalesces concurrent PAT exchanges without cancellation poisoning", async () => {
  clearQoderCnPatCacheForTest();
  let calls = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = async (url: string) => {
    calls += 1;
    if (url.includes("jobToken/exchange")) {
      await blocked;
      return Response.json({ token: "jt-cn-shared", expires_in: 3600 });
    }
    return Response.json({ id: "cn-user" });
  };
  const controller = new AbortController();
  const cancelled = resolveQoderCnPat("pt-cn-shared", {
    fetchImpl,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  const survivor = resolveQoderCnPat("pt-cn-shared", { fetchImpl });
  controller.abort(new Error("caller cancelled"));
  release?.();
  assert.equal(((await cancelled) as Error).message, "caller cancelled");
  assert.equal((await survivor).accessToken, "jt-cn-shared");
  assert.equal(calls, 2);
  clearQoderCnPatCacheForTest();
});

test("Qoder CN rejects invalid PATs before network access", async () => {
  const fetchImpl = async () => {
    throw new Error("network must not be used");
  };
  await assert.rejects(() => resolveQoderCnPat("jt-not-a-pat", { fetchImpl }), /PAT is invalid/);
});
