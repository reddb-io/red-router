import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The owner-side tenant API against a real database: authentication, validation and the
// instance-wide-scope rule for tenant keys.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-tenants-api-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-tenants-api";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "tenants-api-test-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const { getApiKeyMetadata } = await import("../../../src/lib/db/apiKeys.ts");
const tenantsRoute = await import("../../../src/app/api/tenants/route.ts");
const tenantRoute = await import("../../../src/app/api/tenants/[id]/route.ts");
const usersRoute = await import("../../../src/app/api/tenants/[id]/users/route.ts");
const userRoute = await import("../../../src/app/api/tenants/[id]/users/[userId]/route.ts");
const resourcesRoute = await import("../../../src/app/api/tenants/[id]/resources/route.ts");
const sharedRoute = await import("../../../src/app/api/tenants/[id]/shared/route.ts");
const keysRoute = await import("../../../src/app/api/keys/route.ts");
const resourceListRoute = await import("../../../src/app/api/tenants/resources/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

async function sessionCookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret()!);
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

async function send(
  handler: (request: Request, context: never) => Promise<Response>,
  method: string,
  body?: unknown,
  params: Record<string, string> = {},
  authenticated = true
) {
  return handler(
    new Request("http://localhost/api/tenants", {
      method,
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { cookie: await sessionCookie() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) } as never
  );
}

test("every tenant handler refuses a caller without a management session", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  const p = { id: "red", userId: "x" };
  assert.equal((await send(tenantsRoute.GET, "GET", undefined, {}, false)).status, 401);
  assert.equal((await send(tenantsRoute.POST, "POST", { slug: "acme" }, {}, false)).status, 401);
  assert.equal((await send(tenantRoute.PATCH, "PATCH", { name: "x" }, p, false)).status, 401);
  assert.equal((await send(tenantRoute.DELETE, "DELETE", undefined, p, false)).status, 401);
  assert.equal((await send(usersRoute.GET, "GET", undefined, p, false)).status, 401);
  assert.equal((await send(usersRoute.POST, "POST", { email: "a@b.io" }, p, false)).status, 401);
  assert.equal((await send(userRoute.PATCH, "PATCH", { role: "user" }, p, false)).status, 401);
  assert.equal((await send(userRoute.DELETE, "DELETE", undefined, p, false)).status, 401);
  assert.equal(
    (await send(resourcesRoute.POST, "POST", { comboIds: ["x"] }, p, false)).status,
    401
  );
  assert.equal(
    (await send(sharedRoute.PUT, "PUT", { kind: "combo", id: "x", shared: true }, p, false)).status,
    401
  );
  assert.equal((await send(resourceListRoute.GET, "GET", undefined, {}, false)).status, 401);
  assert.equal((await send(tenantsRoute.GET, "GET")).status, 200, "a management session gets in");
});

test("the tenant list starts with 'red' and shows counts", async () => {
  const res = await send(tenantsRoute.GET, "GET");
  const { tenants } = (await res.json()) as { tenants: Array<Record<string, unknown>> };
  assert.equal(tenants[0].slug, "red");
  assert.equal(tenants[0].isDefault, true);
  for (const field of ["admins", "users", "apiKeys", "connections", "combos"]) {
    assert.equal(typeof tenants[0][field], "number");
  }
});

test("create, rename, disable and delete a tenant, with fixed error messages", async () => {
  assert.equal((await send(tenantsRoute.POST, "POST", { slug: "A B" })).status, 400);
  const created = await send(tenantsRoute.POST, "POST", { slug: "acme", name: "Acme Corp" });
  assert.equal(created.status, 201);
  const { tenant } = (await created.json()) as { tenant: { id: string } };
  assert.equal((await send(tenantsRoute.POST, "POST", { slug: "acme" })).status, 409);

  const p = { id: tenant.id };
  assert.equal((await send(tenantRoute.PATCH, "PATCH", {}, p)).status, 400);
  assert.equal((await send(tenantRoute.PATCH, "PATCH", { name: "Acme Inc" }, p)).status, 200);
  assert.equal(
    (await send(tenantRoute.PATCH, "PATCH", { disabled: true }, { id: "red" })).status,
    403
  );
  assert.equal((await send(tenantRoute.PATCH, "PATCH", { name: "x" }, { id: "nope" })).status, 404);
  assert.equal((await send(tenantRoute.DELETE, "DELETE", undefined, { id: "red" })).status, 403);
  assert.equal((await send(tenantRoute.DELETE, "DELETE", undefined, p)).status, 200);
});

test("assign a tenant admin and users; they show up in the list", async () => {
  const { tenant } = (await (await send(tenantsRoute.POST, "POST", { slug: "globex" })).json()) as {
    tenant: { id: string };
  };
  const p = { id: tenant.id };
  const admin = await send(usersRoute.POST, "POST", { email: "boss@globex.io", role: "admin" }, p);
  assert.equal(admin.status, 201);
  const { user } = (await admin.json()) as { user: { id: string; role: string } };
  assert.equal(user.role, "admin");
  assert.equal((await send(usersRoute.POST, "POST", { email: "boss@globex.io" }, p)).status, 409);
  assert.equal((await send(usersRoute.POST, "POST", { email: "nope" }, p)).status, 400);
  assert.equal(
    (await send(usersRoute.POST, "POST", { email: "a@b.io" }, { id: "missing" })).status,
    404
  );

  const listed = (await (await send(usersRoute.GET, "GET", undefined, p)).json()) as {
    users: unknown[];
  };
  assert.equal(listed.users.length, 1);
  const demoted = await send(userRoute.PATCH, "PATCH", { role: "user" }, { ...p, userId: user.id });
  assert.equal(((await demoted.json()) as { user: { role: string } }).user.role, "user");
  assert.equal(
    (await send(userRoute.DELETE, "DELETE", undefined, { ...p, userId: user.id })).status,
    200
  );
});

test("a key created for a tenant belongs to it; instance-wide scopes are refused", async () => {
  const { tenant } = (await (
    await send(tenantsRoute.POST, "POST", { slug: "initech" })
  ).json()) as {
    tenant: { id: string };
  };
  const ok = await send(keysRoute.POST, "POST", { name: "team key", tenantId: "initech" });
  assert.equal(ok.status, 201);
  const body = (await ok.json()) as { key: string; tenantId: string };
  assert.equal(body.tenantId, tenant.id);
  assert.equal((await getApiKeyMetadata(body.key))?.tenantId, tenant.id);

  const manage = await send(keysRoute.POST, "POST", {
    name: "bad",
    tenantId: "initech",
    scopes: ["manage"],
  });
  assert.equal(manage.status, 400);
  const missing = await send(keysRoute.POST, "POST", { name: "x", tenantId: "ghost" });
  assert.equal(missing.status, 404);

  // The default tenant may still hold management keys.
  const red = await send(keysRoute.POST, "POST", { name: "ops", scopes: ["manage"] });
  assert.equal(red.status, 201);
});

test("sharing is only allowed for the owning tenant's own resources", async () => {
  const { tenant } = (await (await send(tenantsRoute.POST, "POST", { slug: "hooli" })).json()) as {
    tenant: { id: string };
  };
  const p = { id: tenant.id };
  assert.equal(
    (await send(sharedRoute.PUT, "PUT", { kind: "combo", id: "ghost", shared: true }, p)).status,
    404
  );
  assert.equal(
    (await send(sharedRoute.PUT, "PUT", { kind: "bogus", id: "x", shared: true }, p)).status,
    400
  );
  assert.equal((await send(resourcesRoute.POST, "POST", {}, p)).status, 400);
});
