import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { qoderCn } from "../../src/lib/oauth/providers/qoder-cn.ts";

test("Qoder CN device login uses its own host and a matching PKCE challenge", () => {
  const flow = qoderCn.requestDeviceCode();
  const url = new URL(flow.verification_uri_complete);
  assert.equal(url.origin, "https://qoder.com.cn");
  assert.equal(url.pathname, "/device/selectAccounts");
  assert.equal(url.searchParams.get("nonce"), flow.device_code);
  assert.equal(url.searchParams.get("machine_id"), flow._qoderMachineId);
  assert.equal(url.searchParams.get("challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("challenge"),
    createHash("sha256").update(flow.codeVerifier).digest("base64url")
  );
  assert.notEqual(
    qoderCn.config.deviceTokenUrl,
    "https://openapi.qoder.sh/api/v1/deviceToken/poll"
  );
});

test("Qoder CN poll stays on the CN API and maps a device token without a fake refresh", async () => {
  const flow = qoderCn.requestDeviceCode();
  const originalFetch = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (url.pathname.endsWith("/deviceToken/poll")) {
      assert.equal(url.host, "openapi.qoder.com.cn");
      assert.equal(url.searchParams.get("nonce"), flow.device_code);
      assert.equal(url.searchParams.get("verifier"), flow.codeVerifier);
      return Response.json({ token: "dt-cn-test", user_id: "cn-user", expires_in: 3600 });
    }
    assert.equal(url.toString(), "https://openapi.qoder.com.cn/api/v1/userinfo");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer dt-cn-test");
    return Response.json({ name: "Qoder CN User", email: "cn@example.test" });
  };
  try {
    const result = await qoderCn.pollToken(null, flow.device_code, flow.codeVerifier, {
      _qoderMachineId: flow._qoderMachineId,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(calls.length, 2);
    const mapped = qoderCn.mapTokens(result.data);
    assert.equal(mapped.accessToken, "dt-cn-test");
    assert.equal(mapped.refreshToken, null);
    assert.equal(mapped.expiresIn, 3600);
    assert.equal(mapped.email, "cn@example.test");
    assert.deepEqual(mapped.providerSpecificData, {
      authMethod: "device",
      userId: "cn-user",
      machineId: flow._qoderMachineId,
      region: "cn",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qoder CN polling keeps pending responses pending and never echoes upstream errors", async () => {
  const flow = qoderCn.requestDeviceCode();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 202 });
    assert.deepEqual(await qoderCn.pollToken(null, flow.device_code, flow.codeVerifier), {
      ok: false,
      data: { error: "authorization_pending" },
    });
    globalThis.fetch = async () => new Response("secret at /srv/token", { status: 403 });
    assert.deepEqual(await qoderCn.pollToken(null, flow.device_code, flow.codeVerifier), {
      ok: false,
      data: { error: "device_token_failed" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qoder CN does not persist tokens without a stable user ID", async () => {
  const flow = qoderCn.requestDeviceCode();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("deviceToken/poll")
      ? Response.json({ token: "dt-cn-test", expires_in: 3600 })
      : Response.json({});
  try {
    assert.deepEqual(await qoderCn.pollToken(null, flow.device_code, flow.codeVerifier), {
      ok: false,
      data: { error: "missing_user_id" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qoder CN validates polling input before network access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used");
  };
  try {
    assert.deepEqual(await qoderCn.pollToken(null, "bad", "bad"), {
      ok: false,
      data: { error: "invalid_request" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qoder CN rejects an expired device token without saving it", async () => {
  const flow = qoderCn.requestDeviceCode();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("deviceToken/poll")
      ? Response.json({ token: "dt-cn-expired", user_id: "cn-user", expires_in: 0 })
      : Response.json({});
  try {
    await assert.rejects(
      () => qoderCn.pollToken(null, flow.device_code, flow.codeVerifier),
      /already expired/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qoder CN bounds response bodies before parsing provider data", async () => {
  const flow = qoderCn.requestDeviceCode();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ token: "dt-" + "x".repeat(70 * 1024) });
  try {
    await assert.rejects(
      () => qoderCn.pollToken(null, flow.device_code, flow.codeVerifier),
      /response exceeded limit/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
