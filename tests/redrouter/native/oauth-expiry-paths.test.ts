import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-oauth-expiry-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "oauth-expiry-regression-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const wrapper = await import("../../../src/sse/services/tokenRefresh.ts");
const engine = await import("../../../open-sse/services/tokenRefresh.ts");
const { BaseExecutor } = await import("../../../open-sse/executors/base.ts");
const { OAUTH_ENDPOINTS } = await import("../../../open-sse/config/constants.ts");
const { parseTokenExpiryMs: healthParser } =
  await import("../../../src/lib/tokenHealthCheckExpiry.ts");
const { parseTokenExpiryMs } = await import("../../../open-sse/utils/tokenExpiry.ts");

const now = Date.parse("2026-10-02T12:00:00.000Z");
const shapes = (milliseconds: number) => [
  new Date(milliseconds).toISOString(),
  milliseconds,
  String(milliseconds),
  Math.floor(milliseconds / 1000),
  String(Math.floor(milliseconds / 1000)),
];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  engine._clearTokenRotationMap();
});
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("health checks and request execution share the same expiry parser", () => {
  assert.equal(healthParser, parseTokenExpiryMs);
});

test("executor refresh decisions accept ISO and numeric seconds/milliseconds", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const executor = new BaseExecutor("claude", {});
  // Imported legacy records may contain values outside the current credential
  // type; exercise the defensive runtime boundary without widening that type.
  const needsRefresh = (expiresAt: unknown) =>
    executor.needsRefresh({ expiresAt } as Parameters<typeof executor.needsRefresh>[0]);
  for (const expiresAt of shapes(now + 60_000)) {
    assert.equal(needsRefresh(expiresAt), true, String(expiresAt));
  }
  for (const expiresAt of shapes(now + 60 * 60_000)) {
    assert.equal(needsRefresh(expiresAt), false, String(expiresAt));
  }
  for (const expiresAt of ["not-a-date", "", "   ", 0, Number.NaN, null]) {
    assert.equal(needsRefresh(expiresAt), false, String(expiresAt));
  }
});

test("an imported textual epoch refreshes before expiry and persists rotated tokens", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  let requests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), OAUTH_ENDPOINTS.anthropic.token);
    requests++;
    return Response.json({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    });
  }) as typeof fetch;

  for (const expiresAt of [String(now + 60_000), String((now + 60_000) / 1000)]) {
    const connection = await providers.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: `Epoch ${expiresAt}`,
      accessToken: `old-access-${expiresAt}`,
      refreshToken: `old-refresh-${expiresAt}`,
      expiresAt,
    });
    const connectionId = String(connection.id);
    const result = await wrapper.checkAndRefreshToken("claude", {
      ...connection,
      connectionId,
    });
    const stored = await providers.getProviderConnectionById(connectionId);
    assert.equal(result.accessToken, "fresh-access");
    assert.equal(stored.accessToken, "fresh-access");
    assert.equal(stored.refreshToken, "fresh-refresh");
    assert.equal(stored.expiresAt, new Date(now + 3600_000).toISOString());
  }
  assert.equal(requests, 2);
});

test("a newer DB token with textual expiry is reused without another OAuth rotation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const connection = await providers.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "Stale in-memory credential",
    accessToken: "stale-access",
    refreshToken: "stale-refresh",
    expiresAt: new Date(now - 1000).toISOString(),
  });
  const connectionId = String(connection.id);
  const absoluteExpiry = String(now + 3600_000);
  await providers.updateProviderConnection(connectionId, {
    accessToken: "db-access",
    refreshToken: "db-refresh",
    expiresAt: absoluteExpiry,
  });
  globalThis.fetch = (async () => {
    throw new Error("valid rotated DB token must not be exchanged again");
  }) as typeof fetch;
  const result = await engine.getAccessToken(
    "claude",
    {
      connectionId,
      accessToken: "stale-access",
      refreshToken: "stale-refresh",
      expiresAt: connection.expiresAt,
    },
    undefined
  );
  assert.equal(result.accessToken, "db-access");
  assert.equal(result.refreshToken, "db-refresh");
  assert.equal(result.expiresAt, absoluteExpiry);
  assert.equal(result.expiresIn, undefined, "absolute expiry must not extend token lifetime");
});

test("malformed expiry does not trigger an unnecessary refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  globalThis.fetch = (async () => {
    throw new Error("unknown expiry must not trigger proactive OAuth refresh");
  }) as typeof fetch;
  const credentials = { accessToken: "valid-access", refreshToken: "valid-refresh" };
  for (const expiresAt of ["not-a-date", "0", "", "   "]) {
    const result = await wrapper.checkAndRefreshToken("claude", { ...credentials, expiresAt });
    assert.equal(result.accessToken, credentials.accessToken);
    assert.equal(result.refreshToken, credentials.refreshToken);
  }
});
