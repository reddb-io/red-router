import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-network-auth-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-network-access";
process.env.STORAGE_ENCRYPTION_KEY = "test-encryption-secret-for-network-access";
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const route = await import("../../../src/app/api/settings/network/route.ts");
const guard = await import("../../../src/server/authz/routeGuard.ts");
const { SPAWN_CAPABLE_PREFIXES } =
  await import("../../../src/shared/constants/spawnCapablePrefixes.ts");
const { AUTHZ_HEADER_PEER_LOCALITY } = await import("../../../src/server/authz/headers.ts");
before(() => updateSettings({ requireLogin: false }));
after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});
const url = "http://localhost:25050/api/settings/network";
async function request(body?: unknown, locality?: string) {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  const headers: Record<string, string> = {
    cookie: `${DASHBOARD_SESSION_COOKIE}=${token}`,
    host: "localhost:25050",
    "x-forwarded-for": "127.0.0.1",
    "Content-Type": "application/json",
  };
  if (locality) headers[AUTHZ_HEADER_PEER_LOCALITY] = locality;
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("read status requires authentication even when dashboard login enforcement is off", async () => {
  const response = await route.GET(new Request(url));
  assert.ok(response.status === 401 || response.status === 403);
});
test("remote reads are allowed but service mutations stay loopback-only and cannot be bypassed", () => {
  assert.equal(guard.isLocalOnlyPath("/api/settings/network", "GET"), false);
  assert.equal(guard.isLocalOnlyPath("/api/settings/network", "POST"), true);
  assert.ok(SPAWN_CAPABLE_PREFIXES.includes("/api/settings/network"));
  assert.equal(guard.isLocalOnlyBypassableByManageScope("/api/settings/network"), false);
});
test("spoofed Host and forwarded IP cannot authorize a restart", async () => {
  const response = await route.POST(await request({ mode: "lan" }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.ok(!body.error.message.includes("at /"));
});
test("authenticated remote status cannot enable the local-only apply control", async () => {
  const response = await route.GET(await request(undefined, "lan"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).canApply, false);
});
test("only the two known exposure modes are accepted", async () => {
  const response = await route.POST(await request({ mode: "0.0.0.0; bad" }, "loopback"));
  assert.equal(response.status, 400);
  assert.ok(!(await response.json()).error.message.includes("at /"));
});
