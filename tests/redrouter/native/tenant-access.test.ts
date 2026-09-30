import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-access-"));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = "tenant-access-jwt-secret";
process.env.API_KEY_SECRET ||= "tenant-access-key-secret";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const {
  createTenant,
  createTenantUser,
  updateTenantUser,
  deleteTenantUser,
  assignApiKeysToTenant,
} = await import("../../../src/lib/db/tenants.ts");
const { getTenantProfile, saveTenantProfile, listAccessUsers } =
  await import("../../../src/lib/db/tenantProfiles.ts");
const { getTenantMonthlyUsage, tenantMonthWindow } =
  await import("../../../src/lib/db/tenantUsage.ts");
const { createApiKey, deleteApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { recordLedgerEntry, recordLedgerEntries } =
  await import("../../../src/lib/db/costLedger.ts");
const { saveRequestUsage } = await import("../../../src/lib/usage/usageHistory.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { mintDashboardSessionToken, getDashboardJwtSecret, DASHBOARD_SESSION_COOKIE } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const usersRoute = await import("../../../src/app/api/access/users/route.ts");
const profileRoute = await import("../../../src/app/api/tenants/[id]/profile/route.ts");
const usageRoute = await import("../../../src/app/api/tenants/[id]/usage/route.ts");
const { areaUrl, canonicalDashboardPath, dashboardUrlRedirects } =
  await import("../../../src/shared/constants/dashboardUrls.ts");
const { findNavMatch, resolveNavSections } =
  await import("../../../src/shared/constants/sidebarNav.ts");

after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("tenant ownership requires a local active admin and protects membership until transfer", () => {
  const a = createTenant({ slug: "owners-a" });
  const b = createTenant({ slug: "owners-b" });
  const owner = createTenantUser(a.id, { email: "owner@a.test", role: "admin" });
  const successor = createTenantUser(a.id, { email: "next@a.test", role: "admin" });
  const outsider = createTenantUser(b.id, { email: "owner@b.test", role: "admin" });
  const member = createTenantUser(a.id, { email: "user@a.test", role: "user" });
  assert.throws(() => saveTenantProfile(a.id, { ownerUserId: outsider.id }), /active admin/);
  assert.throws(() => saveTenantProfile(a.id, { ownerUserId: member.id }), /active admin/);
  updateTenantUser(a.id, successor.id, { disabled: true });
  assert.throws(() => saveTenantProfile(a.id, { ownerUserId: successor.id }), /active admin/);
  updateTenantUser(a.id, successor.id, { disabled: false });
  saveTenantProfile(a.id, {
    ownerUserId: owner.id,
    ownerEmail: "contact@a.test",
    metadata: { region: "br" },
  });
  assert.equal(getTenantProfile(a.id).metadata.region, "br");
  assert.throws(() => updateTenantUser(a.id, owner.id, { disabled: true }), /Transfer/);
  assert.throws(() => updateTenantUser(a.id, owner.id, { role: "user" }), /Transfer/);
  assert.throws(() => deleteTenantUser(a.id, owner.id), /Transfer/);
  assert.equal(listAccessUsers(a.id).find((user) => user.id === owner.id)?.isOwner, true);
  saveTenantProfile(a.id, { ownerUserId: successor.id });
  deleteTenantUser(a.id, owner.id);
  assert.equal(listAccessUsers(a.id).length, 2);
  assert.throws(() => saveTenantProfile(a.id, { billingEmail: "invalid" }), /Invalid/);
  assert.throws(
    () =>
      saveTenantProfile(a.id, {
        metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(i), "x"])),
      }),
    /Invalid/
  );
});

test("monthly reports keep original tenant history after key moves and deletion, with exclusive UTC boundaries", async () => {
  const a = createTenant({ slug: "usage-a" });
  const b = createTenant({ slug: "usage-b" });
  const key = await createApiKey("Tenant key", "access-tests", []);
  const idle = await createApiKey("Unused key", "access-tests", []);
  assignApiKeysToTenant(a.id, [key.id, idle.id]);
  const write = async (timestamp: string, success = true) => {
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-test",
      apiKeyId: key.id,
      apiKeyName: "Tenant key",
      timestamp,
      success,
      tokens: { input_tokens: 10, output_tokens: 4 },
    });
    recordLedgerEntry({
      provider: "openai",
      model: "gpt-test",
      apiKeyId: key.id,
      timestamp,
      success,
      amountUsd: 0.25,
    });
  };
  await write("2026-09-01T00:00:00.000Z");
  await write("2026-09-30T23:59:59.999Z", false);
  await write("2026-10-01T00:00:00.000Z");
  const first = getTenantMonthlyUsage(a.id, "2026-09");
  assert.deepEqual(first.total, {
    requests: 2,
    errors: 1,
    inputTokens: 20,
    outputTokens: 8,
    recordedCostUsd: 0.5,
    pricedRequests: 2,
  });
  assert.equal(first.keys.find((row) => row.apiKeyId === idle.id)?.requests, 0);
  assignApiKeysToTenant(b.id, [key.id]);
  await write("2026-09-15T12:00:00.000Z");
  recordLedgerEntries([
    {
      provider: "openai",
      model: "gpt-test",
      apiKeyId: key.id,
      timestamp: "2026-09-16T12:00:00.000Z",
      amountUsd: 0.1,
    },
  ]);
  assert.equal(getTenantMonthlyUsage(a.id, "2026-09").total.requests, 2);
  assert.equal(getTenantMonthlyUsage(b.id, "2026-09").total.requests, 1);
  assert.equal(getTenantMonthlyUsage(b.id, "2026-09").total.pricedRequests, 2);
  await deleteApiKey(key.id);
  assert.equal(getTenantMonthlyUsage(a.id, "2026-09").total.recordedCostUsd, 0.5);
  assert.equal(getTenantMonthlyUsage(b.id, "2026-09").total.requests, 1);
  assert.equal(
    getTenantMonthlyUsage(a.id, "2026-09").keys.find((row) => row.apiKeyId === key.id)?.current,
    false
  );
  assert.equal(getTenantMonthlyUsage("red", "2026-09").total.requests, 0);
  assert.equal(getTenantMonthlyUsage(a.id, "2026-10").total.requests, 1);
  assert.deepEqual(tenantMonthWindow("2024-02"), {
    since: "2024-02-01T00:00:00.000Z",
    until: "2024-03-01T00:00:00.000Z",
  });
  assert.throws(() => tenantMonthWindow("2026-13"), /YYYY-MM/);
  assert.throws(() => getTenantMonthlyUsage("missing", "2026-09"), /not found/);
});

test("Access APIs require management auth and never expose credentials or raw errors", async () => {
  await updateSettings({ requireLogin: true });
  const context = { params: Promise.resolve({ id: "red" }) };
  const unauthenticated = new Request("http://localhost/api/access/users");
  assert.equal((await usersRoute.GET(unauthenticated)).status, 401);
  assert.equal((await profileRoute.GET(unauthenticated, context)).status, 401);
  assert.equal((await usageRoute.GET(unauthenticated, context)).status, 401);
  assert.equal(
    (await profileRoute.PUT(new Request(unauthenticated, { method: "PUT", body: "{}" }), context))
      .status,
    401
  );
  const token = await mintDashboardSessionToken(getDashboardJwtSecret()!);
  const request = (url: string, method = "GET", body?: unknown) =>
    new Request(url, {
      method,
      headers: {
        cookie: `${DASHBOARD_SESSION_COOKIE}=${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const response = await usersRoute.GET(request("http://localhost/api/access/users"));
  assert.equal(response.status, 200);
  const json = await response.text();
  assert.doesNotMatch(
    json,
    /password_hash|passwordHash|session_version|sessionVersion|"key"|"token"/
  );
  const bad = await usageRoute.GET(
    request("http://localhost/api/tenants/red/usage?month=../../x"),
    context
  );
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /at \/|SELECT|\.ts:\d/);
  assert.equal(
    (
      await profileRoute.PUT(
        request("http://localhost/api/tenants/red/profile", "PUT", { ownerEmail: "invalid" }),
        context
      )
    ).status,
    400
  );
  assert.equal(
    (
      await profileRoute.PUT(
        request("http://localhost/api/tenants/red/profile", "PUT", {
          billingEmail: "billing@example.com",
        }),
        context
      )
    ).status,
    200
  );
  assert.equal(getTenantProfile("red").billingEmail, "billing@example.com");
  assert.ok(getDbInstance().prepare("SELECT id FROM tenant_users LIMIT 1").get());
});

test("Access pages own their navigation and old tenant bookmarks redirect in one hop", () => {
  const nav = resolveNavSections(new Set(), {});
  for (const name of ["tenants", "users", "roles"]) {
    assert.equal(areaUrl(`/dashboard/${name}`), `/access/${name}`);
    assert.equal(canonicalDashboardPath(`/access/${name}`), `/dashboard/${name}`);
    assert.equal(findNavMatch(`/access/${name}`, nav)?.section.id, "access");
  }
  assert.ok(
    dashboardUrlRedirects().some(
      (rule) =>
        rule.source === "/system/tenants/:path*" && rule.destination === "/access/tenants/:path*"
    )
  );
});
