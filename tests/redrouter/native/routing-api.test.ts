import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

// The routing policy APIs: the owner's, the owner's pin per tenant, and the tenant admin's, which the
// owner can lock. The owner always has the last word.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-routing-api-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-routing-api";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "routing-api-test-secret";
delete process.env.INITIAL_PASSWORD;

const OWNER_PASSWORD = "correct horse battery staple 42";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const dash = await import("../../../src/shared/utils/dashboardSessionToken.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const tenantAuth = await import("../../../src/lib/db/tenantAuth.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const session = await import("../../../src/lib/auth/tenantSession.ts");
const rows = await import("../../../src/lib/db/routingPolicy.ts");
const policy = await import("../../../src/lib/routing/routingPolicy.ts");
const { runAuthzPipeline } = await import("../../../src/server/authz/pipeline.ts");
const instanceRoute = await import("../../../src/app/api/routing/route.ts");
const pinRoute = await import("../../../src/app/api/tenants/[id]/routing/route.ts");
const tenantRoute = await import("../../../src/app/api/tenant/routing/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

let acme: { id: string };
let adminId: string;
let userId: string;

async function connect(provider: string, tenantId?: string) {
  const conn = (await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${tenantId ?? "red"}`,
    apiKey: `sk-${provider}`,
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  if (tenantId) tenants.assignResourcesToTenant(tenantId, { connectionIds: [conn.id] });
}

beforeEach(async () => {
  const db = getDbInstance();
  for (const table of [
    "tenant_routing_policy",
    "tenant_users",
    "provider_connections",
    "tenant_shared_resources",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword(OWNER_PASSWORD),
    transparentModels: true,
    providerPriority: [],
    delegateRoutingToTenants: false,
  });
  acme = tenants.createTenant({ slug: "acme" });
  await connect("openai", acme.id);
  await connect("groq", acme.id);
  await connect("mistral"); // the owner's own, not shared
  const admin = tenants.createTenantUser(acme.id, { email: "boss@acme.io", role: "admin" });
  const plain = tenants.createTenantUser(acme.id, { email: "member@acme.io", role: "user" });
  tenantAuth.setTenantUserPassword(
    admin.id,
    await hashManagementPassword("a long tenant passphrase 2026")
  );
  tenantAuth.setTenantUserPassword(
    plain.id,
    await hashManagementPassword("a long tenant passphrase 2026")
  );
  adminId = admin.id;
  userId = plain.id;
});

const ownerCookie = async () =>
  `${dash.DASHBOARD_SESSION_COOKIE}=${await dash.mintDashboardSessionToken(dash.getDashboardJwtSecret()!, "owner")}`;
async function tenantCookie(id: string) {
  const auth = tenantAuth.getTenantUserAuthById(id)!;
  return `${session.TENANT_SESSION_COOKIE}=${await session.mintTenantSessionToken({ userId: auth.id, tenantId: auth.tenantId, sessionVersion: auth.sessionVersion })}`;
}
const req = (method: string, body?: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const idCtx = () => ({ params: Promise.resolve({ id: acme.id }) });

test("the owner's endpoints need a management session; the tenant's need a tenant admin", async () => {
  assert.equal((await instanceRoute.GET(req("GET"))).status, 401);
  assert.equal((await instanceRoute.PUT(req("PUT", { transparent: false }))).status, 401);
  assert.equal((await pinRoute.GET(req("GET"), idCtx())).status, 401);
  assert.equal((await pinRoute.PUT(req("PUT", { transparent: false }), idCtx())).status, 401);
  assert.equal((await tenantRoute.GET(req("GET"))).status, 401);
  assert.equal((await tenantRoute.PUT(req("PUT", { transparent: false }))).status, 401);
  // A tenant session is not a management session, and a plain user is not an admin.
  const tenantCk = await tenantCookie(adminId);
  assert.equal((await instanceRoute.GET(req("GET", undefined, tenantCk))).status, 401);
  assert.equal(
    (await pinRoute.PUT(req("PUT", { transparent: false }, tenantCk), idCtx())).status,
    401
  );
  assert.equal(
    (await tenantRoute.GET(req("GET", undefined, await tenantCookie(userId)))).status,
    403
  );
  assert.equal(
    (await tenantRoute.PUT(req("PUT", { transparent: false }, await tenantCookie(userId)))).status,
    403
  );
  assert.equal(
    (await tenantRoute.GET(req("GET", undefined, await ownerCookie()))).status,
    401,
    "the owner uses /api/tenants/:id/routing"
  );
});

test("through the pipeline, tenant routing is reachable only by a tenant admin", async () => {
  const allowed = async (path: string, method: string, cookie: string) =>
    (
      await runAuthzPipeline(
        new NextRequest(`http://localhost${path}`, {
          method,
          headers: { cookie, origin: "http://localhost" },
        }),
        { enforce: true }
      )
    ).headers.get("x-middleware-next") === "1";
  const admin = await tenantCookie(adminId);
  const plain = await tenantCookie(userId);
  assert.equal(await allowed("/api/tenant/routing", "GET", admin), true);
  assert.equal(await allowed("/api/tenant/routing", "PUT", admin), true);
  assert.equal(await allowed("/api/tenant/routing", "PUT", plain), false);
  assert.equal(await allowed("/api/tenant/routing", "DELETE", admin), false);
  assert.equal(
    await allowed("/api/routing", "GET", admin),
    false,
    "the owner's endpoint is not the tenant's"
  );
  assert.equal(await allowed("/api/tenants/x/routing", "PUT", admin), false);
});

test("the owner sets the instance's mode, order and delegation, and reads them back", async () => {
  const cookie = await ownerCookie();
  const put = await instanceRoute.PUT(
    req(
      "PUT",
      {
        transparent: false,
        providerPriority: [" kiro ", "openai", "kiro"],
        delegateToTenants: true,
      },
      cookie
    )
  );
  assert.equal(put.status, 200);
  const settings = (await getSettings()) as Record<string, unknown>;
  assert.equal(settings.transparentModels, false);
  assert.deepEqual(settings.providerPriority, ["kiro", "openai"], "cleaned");
  assert.equal(settings.delegateRoutingToTenants, true);

  const got = (await (await instanceRoute.GET(req("GET", undefined, cookie))).json()) as {
    policy: { transparent: boolean; delegated: boolean };
    providers: Array<{ id: string }>;
    tenants: Array<{ slug: string; effective: { transparent: boolean } }>;
  };
  assert.equal(got.policy.transparent, false);
  assert.equal(got.policy.delegated, true);
  assert.deepEqual(got.providers.map((p) => p.id).sort(), ["groq", "mistral", "openai"]);
  assert.equal(got.tenants.find((t) => t.slug === "acme")!.effective.transparent, false);
  assert.equal((await instanceRoute.PUT(req("PUT", {}, cookie))).status, 400);
  assert.equal((await instanceRoute.PUT(req("PUT", { transparent: "no" }, cookie))).status, 400);
});

test("the owner can pin a tenant, and clear the pin", async () => {
  const cookie = await ownerCookie();
  const pinned = await pinRoute.PUT(
    req("PUT", { transparent: false, priority: ["groq", "openai"] }, cookie),
    idCtx()
  );
  assert.equal(pinned.status, 200);
  const eff = (
    (await pinned.json()) as {
      effective: {
        transparent: boolean;
        providerPriority: string[];
        source: Record<string, string>;
      };
    }
  ).effective;
  assert.deepEqual([eff.transparent, eff.providerPriority], [false, ["groq", "openai"]]);
  assert.deepEqual(eff.source, { transparent: "owner", providerPriority: "owner" });

  const cleared = await pinRoute.PUT(
    req("PUT", { transparent: null, priority: null }, cookie),
    idCtx()
  );
  assert.equal(
    ((await cleared.json()) as { effective: { source: { transparent: string } } }).effective.source
      .transparent,
    "instance"
  );
  assert.equal((await pinRoute.PUT(req("PUT", {}, cookie), idCtx())).status, 400);
  assert.equal(
    (
      await pinRoute.PUT(req("PUT", { transparent: false }, cookie), {
        params: Promise.resolve({ id: "ghost" }),
      })
    ).status,
    404
  );
});

test("a tenant admin can change nothing until the owner delegates: the owner has the last word", async () => {
  const admin = await tenantCookie(adminId);
  const state = (await (await tenantRoute.GET(req("GET", undefined, admin))).json()) as {
    delegated: boolean;
    locked: { transparent: boolean; priority: boolean };
  };
  assert.equal(state.delegated, false);
  assert.deepEqual(state.locked, { transparent: true, priority: true });

  for (const body of [{ transparent: false }, { priority: ["openai"] }]) {
    const res = await tenantRoute.PUT(req("PUT", body, admin));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "routing_locked");
  }
  assert.equal(rows.getTenantRoutingRow(acme.id), null, "nothing was written");
});

test("once delegated, the tenant admin sets the mode and the order of ITS providers", async () => {
  await updateSettings({ delegateRoutingToTenants: true });
  const admin = await tenantCookie(adminId);
  const res = await tenantRoute.PUT(
    req("PUT", { transparent: false, priority: ["groq", "openai"] }, admin)
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as {
    effective: { transparent: boolean; providerPriority: string[]; source: Record<string, string> };
    providers: Array<{ id: string }>;
  };
  assert.deepEqual(
    [body.effective.transparent, body.effective.providerPriority],
    [false, ["groq", "openai"]]
  );
  assert.deepEqual(body.effective.source, { transparent: "tenant", providerPriority: "tenant" });
  assert.deepEqual(
    body.providers.map((p) => p.id).sort(),
    ["groq", "openai"],
    "the owner's own mistral is not the tenant's to order"
  );
});

test("a tenant cannot order a provider it cannot use", async () => {
  await updateSettings({ delegateRoutingToTenants: true });
  const res = await tenantRoute.PUT(
    req("PUT", { priority: ["openai", "mistral", "nope"] }, await tenantCookie(adminId))
  );
  assert.equal(res.status, 400);
  const err = ((await res.json()) as { error: { code: string; providers: string[] } }).error;
  assert.equal(err.code, "unknown_providers");
  assert.deepEqual(err.providers, ["mistral", "nope"]);
});

test("whatever the owner pinned stays locked for the tenant even while delegated", async () => {
  await updateSettings({ delegateRoutingToTenants: true });
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: false });
  const admin = await tenantCookie(adminId);
  const state = (await (await tenantRoute.GET(req("GET", undefined, admin))).json()) as {
    locked: { transparent: boolean; priority: boolean };
  };
  assert.deepEqual(state.locked, { transparent: true, priority: false });
  assert.equal((await tenantRoute.PUT(req("PUT", { transparent: true }, admin))).status, 403);
  assert.equal(
    (await tenantRoute.PUT(req("PUT", { priority: ["openai"] }, admin))).status,
    200,
    "the order is still the tenant's"
  );
  assert.equal((await policy.resolveRoutingPolicy(acme.id)).transparent, false);
});

test("taking delegation back re-locks the tenant and its earlier choice stops applying", async () => {
  await updateSettings({ delegateRoutingToTenants: true, transparentModels: true });
  const admin = await tenantCookie(adminId);
  assert.equal((await tenantRoute.PUT(req("PUT", { transparent: false }, admin))).status, 200);
  assert.equal((await policy.resolveRoutingPolicy(acme.id)).transparent, false);
  await updateSettings({ delegateRoutingToTenants: false });
  assert.equal(
    (await policy.resolveRoutingPolicy(acme.id)).transparent,
    true,
    "the owner's instance policy is back in charge"
  );
  assert.equal((await tenantRoute.PUT(req("PUT", { transparent: true }, admin))).status, 403);
});

test("a tenant can clear its own choice with null", async () => {
  await updateSettings({ delegateRoutingToTenants: true });
  const admin = await tenantCookie(adminId);
  await tenantRoute.PUT(req("PUT", { transparent: false, priority: ["openai"] }, admin));
  const res = await tenantRoute.PUT(req("PUT", { transparent: null, priority: null }, admin));
  assert.equal(res.status, 200);
  assert.deepEqual(rows.getTenantRoutingRow(acme.id), {
    tenantId: acme.id,
    ownerTransparent: null,
    ownerPriority: null,
    tenantTransparent: null,
    tenantPriority: null,
  });
});
