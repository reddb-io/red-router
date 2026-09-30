import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

// Tenant sign-in and the boundary between a tenant session and everything else: tokens cannot be
// confused, a route not in the manifest is refused, and NO management route accepts a tenant.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-tenant-auth-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-tenant-auth";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "tenant-auth-test-secret";
delete process.env.INITIAL_PASSWORD;
delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;

const OWNER_PASSWORD = "correct horse battery staple 42";
const TENANT_PASSWORD = "a long tenant passphrase 2026";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const dash = await import("../../../src/shared/utils/dashboardSessionToken.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const tenantAuth = await import("../../../src/lib/db/tenantAuth.ts");
const mfa = await import("../../../src/lib/db/mfa.ts");
const { totpCode } = await import("../../../src/lib/auth/totp.ts");
const session = await import("../../../src/lib/auth/tenantSession.ts");
const { tenantCookieInternals } = await import("../../../src/lib/auth/tenantSessionCookie.ts");
const { sessionCookieInternals } = await import("../../../src/lib/auth/dashboardSessionCookie.ts");
const { resetLoginGuardForTests } = await import("../../../src/server/auth/loginGuard.ts");
const { runAuthzPipeline } = await import("../../../src/server/authz/pipeline.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { TENANT_ROUTES, matchTenantRoute } =
  await import("../../../src/server/authz/tenantRoutes.ts");
const { auditActorFor } = await import("../../../src/lib/compliance/auditActor.ts");
const { requireManagementAuth } = await import("../../../src/lib/api/requireManagementAuth.ts");
const loginRoute = await import("../../../src/app/api/auth/tenant/login/route.ts");
const ownerLoginRoute = await import("../../../src/app/api/auth/login/route.ts");
const acceptRoute = await import("../../../src/app/api/auth/tenant/accept-invite/route.ts");
const logoutRoute = await import("../../../src/app/api/auth/tenant/logout/route.ts");
const mfaVerifyRoute = await import("../../../src/app/api/auth/mfa/verify/route.ts");
const inviteRoute =
  await import("../../../src/app/api/tenants/[id]/users/[userId]/invite/route.ts");
const sessionsRoute =
  await import("../../../src/app/api/tenants/[id]/users/[userId]/sessions/route.ts");
const meRoute = await import("../../../src/app/api/tenant/me/route.ts");
const tenantUsersRoute = await import("../../../src/app/api/tenant/users/route.ts");
const tenantKeysRoute = await import("../../../src/app/api/tenant/keys/route.ts");
const tenantsRoute = await import("../../../src/app/api/tenants/route.ts");

const cookiesSet: Array<{ name: string; value: string }> = [];
const store = async () => ({
  set(name: string, value: string) {
    cookiesSet.push({ name, value });
  },
});
tenantCookieInternals.getCookieStore = store as never;
sessionCookieInternals.getCookieStore = store as never;
ownerLoginRoute.authRouteInternals.getCookieStore = store as never;

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  cookiesSet.length = 0;
  const db = getDbInstance();
  for (const table of ["tenant_invites", "tenant_users", "auth_mfa", "api_keys"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword(OWNER_PASSWORD),
  });
  resetLoginGuardForTests();
});

// --- helpers -----------------------------------------------------------------------------------

async function makeUser(
  role: "admin" | "user" = "user",
  slug = "acme",
  email = `${role}@${slug}.io`
) {
  const tenant = tenants.getTenant(slug) ?? tenants.createTenant({ slug });
  const user = tenants.createTenantUser(tenant.id, { email, role });
  tenantAuth.setTenantUserPassword(user.id, await hashManagementPassword(TENANT_PASSWORD));
  return { tenant, user, auth: tenantAuth.getTenantUserAuthById(user.id)! };
}

async function tenantCookie(userId: string) {
  const auth = tenantAuth.getTenantUserAuthById(userId)!;
  const token = await session.mintTenantSessionToken({
    userId: auth.id,
    tenantId: auth.tenantId,
    sessionVersion: auth.sessionVersion,
  });
  return `${session.TENANT_SESSION_COOKIE}=${token}`;
}

async function ownerCookie() {
  return `${dash.DASHBOARD_SESSION_COOKIE}=${await dash.mintDashboardSessionToken(dash.getDashboardJwtSecret()!, "owner")}`;
}

function req(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}
) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Whether the authz pipeline lets the request through to its route handler. */
async function pipelineAllows(
  path: string,
  init: Parameters<typeof req>[1] = {}
): Promise<boolean> {
  const res = await runAuthzPipeline(req(path, init), { enforce: true });
  return res.headers.get("x-middleware-next") === "1";
}

const login = (email: string, password: string) =>
  loginRoute.POST(req("/api/auth/tenant/login", { method: "POST", body: { email, password } }));

// --- sign-in -----------------------------------------------------------------------------------

test("a tenant user signs in with e-mail and password and gets a tenant cookie, not a dashboard one", async () => {
  const { user, auth } = await makeUser("admin");
  const res = await login(user.email, TENANT_PASSWORD);
  assert.equal(res.status, 200);
  assert.equal(cookiesSet.length, 1);
  assert.equal(cookiesSet[0].name, "rr_tenant");
  const ctx = await session.authenticateTenantToken(cookiesSet[0].value);
  assert.equal(ctx?.userId, auth.id);
  assert.equal(ctx?.role, "admin");
  assert.equal(
    await dash.verifyDashboardSessionToken(cookiesSet[0].value, dash.getDashboardJwtSecret()),
    null
  );
  assert.equal(tenants.getTenantUser(user.id)?.lastLoginAt !== null, true);
});

test("every failed sign-in looks the same: unknown e-mail, wrong password, no password, disabled", async () => {
  const { user, tenant } = await makeUser("user", "acme", "real@acme.io");
  const noPassword = tenants.createTenantUser(tenant.id, { email: "nopass@acme.io" });
  const disabled = await makeUser("user", "acme", "off@acme.io");
  tenants.updateTenantUser(tenant.id, disabled.user.id, { disabled: true });

  const outcomes = [
    await login("ghost@nowhere.io", TENANT_PASSWORD),
    await login(user.email, "the wrong password entirely"),
    await login(noPassword.email, TENANT_PASSWORD),
    await login(disabled.user.email, TENANT_PASSWORD),
  ];
  const bodies = await Promise.all(outcomes.map((res) => res.json()));
  for (const res of outcomes) assert.equal(res.status, 401);
  for (const body of bodies) assert.deepEqual(body, { error: "Invalid email or password" });
  assert.equal(cookiesSet.length, 0);
});

test("a disabled tenant cannot sign in", async () => {
  const { user, tenant } = await makeUser();
  tenants.updateTenant(tenant.id, { disabled: true });
  assert.equal((await login(user.email, TENANT_PASSWORD)).status, 401);
});

test("five failures lock the client out, in a bucket apart from the owner's sign-in", async () => {
  const { user } = await makeUser();
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1)
    statuses.push((await login(user.email, "wrong password number " + i)).status);
  assert.equal(statuses.at(-1), 429, `statuses: ${statuses}`);
  assert.equal(
    (await login(user.email, TENANT_PASSWORD)).status,
    429,
    "even the right password waits"
  );

  const owner = await ownerLoginRoute.POST(
    req("/api/auth/login", { method: "POST", body: { password: OWNER_PASSWORD } })
  );
  assert.equal(owner.status, 200, "the owner is not locked out by tenant failures");
});

test("with no login on the dashboard, tenant sign-in is refused", async () => {
  const { user } = await makeUser();
  await updateSettings({ requireLogin: false });
  assert.equal((await login(user.email, TENANT_PASSWORD)).status, 403);
});

test("logout clears the tenant cookie", async () => {
  const res = await logoutRoute.POST();
  assert.equal(res.status, 200);
  assert.equal(cookiesSet.at(-1)?.name, "rr_tenant");
  assert.equal(cookiesSet.at(-1)?.value, "");
});

// --- invitations -------------------------------------------------------------------------------

async function invite(tenantId: string, userId: string) {
  const res = await inviteRoute.POST(
    req(`/api/tenants/${tenantId}/users/${userId}/invite`, {
      method: "POST",
      cookie: await ownerCookie(),
    }),
    { params: Promise.resolve({ id: tenantId, userId }) }
  );
  assert.equal(res.status, 201);
  return (await res.json()) as { token: string; expiresAt: string };
}

const accept = (token: string, password: string) =>
  acceptRoute.POST(
    req("/api/auth/tenant/accept-invite", { method: "POST", body: { token, password } })
  );

test("an invitation sets the password once; the person then signs in", async () => {
  const tenant = tenants.createTenant({ slug: "acme" });
  const user = tenants.createTenantUser(tenant.id, { email: "new@acme.io", role: "admin" });
  const { token } = await invite(tenant.id, user.id);
  assert.match(token, /^rri_/);
  assert.equal((await accept(token, TENANT_PASSWORD)).status, 200);
  assert.equal((await login(user.email, TENANT_PASSWORD)).status, 200);
  assert.equal(
    (await accept(token, "another long passphrase 99")).status,
    400,
    "the token works once"
  );
});

test("a weak password is refused without spending the invitation", async () => {
  const tenant = tenants.createTenant({ slug: "acme" });
  const user = tenants.createTenantUser(tenant.id, { email: "weak@acme.io" });
  const { token } = await invite(tenant.id, user.id);
  for (const weak of ["short", "password1234", "aaaaaaaaaaaaaaaa"]) {
    assert.equal((await accept(token, weak)).status, 400, weak);
  }
  assert.equal((await accept(token, TENANT_PASSWORD)).status, 200, "still valid afterwards");
});

test("an expired, unknown or superseded invitation is refused with one generic message", async () => {
  const tenant = tenants.createTenant({ slug: "acme" });
  const user = tenants.createTenantUser(tenant.id, { email: "late@acme.io" });
  const old = await invite(tenant.id, user.id);
  const fresh = await invite(tenant.id, user.id);
  const responses = [
    await accept(old.token, TENANT_PASSWORD),
    await accept("rri_" + "x".repeat(43), TENANT_PASSWORD),
  ];
  for (const res of responses) {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "This invitation is invalid or has expired." });
  }
  getDbInstance()
    .prepare("UPDATE tenant_invites SET expires_at = ?")
    .run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await accept(fresh.token, TENANT_PASSWORD)).status, 400, "expired");
});

test("guessing invitation tokens locks the client out", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1)
    statuses.push((await accept("rri_" + String(i).repeat(43), TENANT_PASSWORD)).status);
  assert.equal(statuses.at(-1), 429, `statuses: ${statuses}`);
});

test("only the owner can invite, and only a user of that tenant", async () => {
  const a = await makeUser("user", "acme");
  const b = await makeUser("user", "globex");
  const anonymous = await inviteRoute.POST(
    req(`/api/tenants/${a.tenant.id}/users/${a.user.id}/invite`, { method: "POST" }),
    { params: Promise.resolve({ id: a.tenant.id, userId: a.user.id }) }
  );
  assert.equal(anonymous.status, 401);
  const wrongTenant = await inviteRoute.POST(
    req("/x", { method: "POST", cookie: await ownerCookie() }),
    { params: Promise.resolve({ id: a.tenant.id, userId: b.user.id }) }
  );
  assert.equal(wrongTenant.status, 404);
});

test("accepting an invitation ends the sessions the user already had", async () => {
  const { user, tenant } = await makeUser();
  const cookie = await tenantCookie(user.id);
  assert.equal((await meRoute.GET(req("/api/tenant/me", { cookie }))).status, 200);
  const { token } = await invite(tenant.id, user.id);
  assert.equal((await accept(token, "a brand new passphrase 77")).status, 200);
  assert.equal((await meRoute.GET(req("/api/tenant/me", { cookie }))).status, 401);
});

// --- session lifetime and revocation -----------------------------------------------------------

test("a role change, disable, sign-out-everywhere or disabled tenant kills the live session at once", async () => {
  const { user, tenant } = await makeUser("admin");
  const cookie = await tenantCookie(user.id);
  const alive = async () => (await meRoute.GET(req("/api/tenant/me", { cookie }))).status === 200;
  assert.equal(await alive(), true);

  tenants.updateTenantUser(tenant.id, user.id, { role: "user" });
  assert.equal(await alive(), false, "role change");

  const cookie2 = await tenantCookie(user.id);
  const stillOk = async () =>
    (await meRoute.GET(req("/api/tenant/me", { cookie: cookie2 }))).status === 200;
  assert.equal(await stillOk(), true);
  const out = await sessionsRoute.DELETE(
    req("/x", { method: "DELETE", cookie: await ownerCookie() }),
    { params: Promise.resolve({ id: tenant.id, userId: user.id }) }
  );
  assert.equal(out.status, 200);
  assert.equal(await stillOk(), false, "sign out everywhere");

  const cookie3 = await tenantCookie(user.id);
  tenants.updateTenant(tenant.id, { disabled: true });
  assert.equal(
    (await meRoute.GET(req("/api/tenant/me", { cookie: cookie3 }))).status,
    401,
    "tenant disabled"
  );
});

test("a tenant token expires, and a tampered one is refused", async (t) => {
  const { user } = await makeUser();
  const auth = tenantAuth.getTenantUserAuthById(user.id)!;
  const token = await session.mintTenantSessionToken({
    userId: auth.id,
    tenantId: auth.tenantId,
    sessionVersion: auth.sessionVersion,
  });
  assert.ok(await session.authenticateTenantToken(token));

  const [head, body, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  claims.tid = "another-tenant";
  const forged = `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  assert.equal(await session.authenticateTenantToken(forged), null, "claims are signed");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(13 * 60 * 60 * 1000);
  assert.equal(await session.authenticateTenantToken(token), null, "expired after the 12 hours");
});

// --- token confusion ---------------------------------------------------------------------------

test("a dashboard session is not a tenant session, and a tenant session is not a dashboard session", async () => {
  const { user } = await makeUser("admin");
  const tenantToken = (await tenantCookie(user.id)).split("=")[1];
  const dashToken = (await ownerCookie()).split("=")[1];

  assert.equal(await session.authenticateTenantToken(dashToken), null);
  assert.equal(
    await dash.verifyDashboardSessionToken(tenantToken, dash.getDashboardJwtSecret()),
    null
  );

  // Each token presented under the other's cookie name gets nowhere.
  const swappedTenant = `${dash.DASHBOARD_SESSION_COOKIE}=${tenantToken}`;
  const swappedOwner = `${session.TENANT_SESSION_COOKIE}=${dashToken}`;
  assert.equal((await meRoute.GET(req("/api/tenant/me", { cookie: swappedOwner }))).status, 401);
  assert.notEqual(
    await requireManagementAuth(req("/api/tenants", { cookie: swappedTenant })),
    null
  );
  assert.equal(await pipelineAllows("/api/tenants", { cookie: swappedTenant }), false);
  assert.equal(await pipelineAllows("/api/tenant/me", { cookie: swappedOwner }), false);
});

test("the owner's session, a management key and the CLI token do not open the tenant surface", async () => {
  const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
  const key = await createApiKey("ops", "tenant-auth-machine", ["manage"]);
  assert.equal(await pipelineAllows("/api/tenant/me", { cookie: await ownerCookie() }), false);
  assert.equal(
    await pipelineAllows("/api/tenant/me", { headers: { authorization: `Bearer ${key.key}` } }),
    false
  );
  assert.equal(await pipelineAllows("/api/tenant/me", {}), false);
});

test("a tenant cookie opens no management page or API", async () => {
  const { user } = await makeUser("admin");
  const cookie = await tenantCookie(user.id);
  for (const path of [
    "/api/tenants",
    "/api/settings",
    "/api/providers",
    "/api/keys",
    "/dashboard",
    "/dashboard/settings/security",
  ]) {
    assert.equal(await pipelineAllows(path, { cookie }), false, path);
  }
  const asHandler = await tenantsRoute.GET(req("/api/tenants", { cookie }));
  assert.equal(asHandler.status, 401, "the handler-level guard refuses it too");
});

test("path tricks cannot smuggle a management route into the tenant class", async () => {
  const { user } = await makeUser("admin");
  const cookie = await tenantCookie(user.id);
  assert.equal(
    classifyRoute("/api/tenants").routeClass,
    "MANAGEMENT",
    "/api/tenants is the owner's"
  );
  assert.equal(classifyRoute("/api/tenant").routeClass, "TENANT");
  assert.equal(classifyRoute("/api/tenant/me").routeClass, "TENANT");
  for (const path of [
    "/api/tenant/me/../../settings",
    "/api/tenant/../settings",
    "/api/tenant/%2e%2e/settings",
    "/api//settings",
    "/api/tenantsx",
  ]) {
    assert.equal(await pipelineAllows(path, { cookie }), false, path);
  }
});

// --- the manifest ------------------------------------------------------------------------------

test("the manifest is an allow-list: unknown routes and wrong methods are 403, roles are enforced", async () => {
  const admin = await makeUser("admin", "acme", "boss@acme.io");
  const plain = await makeUser("user", "acme", "member@acme.io");
  const adminCookie = await tenantCookie(admin.user.id);
  const userCookie = await tenantCookie(plain.user.id);

  assert.equal(await pipelineAllows("/api/tenant/me", { cookie: userCookie }), true);
  assert.equal(
    await pipelineAllows("/api/tenant/users", { cookie: userCookie }),
    false,
    "admin only"
  );
  assert.equal(await pipelineAllows("/api/tenant/users", { cookie: adminCookie }), true);
  assert.equal(await pipelineAllows("/api/tenant/keys", { cookie: adminCookie }), true);

  for (const [method, path] of [
    ["POST", "/api/tenant/me"],
    ["DELETE", "/api/tenant/users"],
    ["GET", "/api/tenant/nope"],
    ["GET", "/api/tenant/me/extra"],
    ["GET", "/api/tenant"],
    ["PUT", "/api/tenant/keys"],
  ]) {
    assert.equal(
      await pipelineAllows(path, {
        cookie: adminCookie,
        method,
        headers: { origin: "http://localhost" },
      }),
      false,
      `${method} ${path}`
    );
    const res = await runAuthzPipeline(
      req(path, { cookie: adminCookie, method, headers: { origin: "http://localhost" } }),
      { enforce: true }
    );
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("a tenant only ever sees its own tenant's users and keys", async () => {
  const a = await makeUser("admin", "acme", "boss@acme.io");
  const b = await makeUser("admin", "globex", "boss@globex.io");
  const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
  const keyA = await createApiKey("a-key", "tenant-auth-machine");
  const keyB = await createApiKey("b-key", "tenant-auth-machine");
  tenants.assignApiKeysToTenant(a.tenant.id, [keyA.id]);
  tenants.assignApiKeysToTenant(b.tenant.id, [keyB.id]);

  const cookieA = await tenantCookie(a.user.id);
  const users = (await (
    await tenantUsersRoute.GET(req("/api/tenant/users", { cookie: cookieA }))
  ).json()) as { users: Array<{ email: string }> };
  assert.deepEqual(
    users.users.map((u) => u.email),
    ["boss@acme.io"]
  );
  const keys = (await (
    await tenantKeysRoute.GET(req("/api/tenant/keys", { cookie: cookieA }))
  ).json()) as { keys: Array<{ name: string }> };
  assert.deepEqual(
    keys.keys.map((k) => k.name),
    ["a-key"]
  );
  const raw = JSON.stringify(keys) + JSON.stringify(users);
  assert.ok(!raw.includes(keyA.key), "no key value");
  assert.ok(!/passwordHash|password_hash|\$2[aby]\$/.test(raw), "no password material");

  const me = (await (await meRoute.GET(req("/api/tenant/me", { cookie: cookieA }))).json()) as {
    capabilities: Array<{ path: string }>;
    tenant: { slug: string };
  };
  assert.equal(me.tenant.slug, "acme");
  assert.deepEqual(me.capabilities.map((c) => c.path).sort(), [
    "/api/tenant/keys",
    "/api/tenant/me",
    "/api/tenant/routing",
    "/api/tenant/routing",
    "/api/tenant/users",
  ]);
});

test("every route file under /api/tenant has a manifest row, and every row has a route file", () => {
  const root = join(process.cwd(), "src/app/api/tenant");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts")
        found.push(relative(join(process.cwd(), "src/app"), dirOf(full)).split(sep).join("/"));
    }
  };
  const dirOf = (file: string) => file.slice(0, file.lastIndexOf(sep));
  walk(root);
  const routes = found.map((path) => "/" + path).sort();
  const manifestPaths = [...new Set(TENANT_ROUTES.map((rule) => rule.pattern))].sort();
  assert.deepEqual(routes, manifestPaths);
  for (const rule of TENANT_ROUTES) {
    const source = readFileSync(join(process.cwd(), "src/app", rule.pattern, "route.ts"), "utf8");
    assert.match(
      source,
      new RegExp(`export async function ${rule.method}\\b`),
      `${rule.method} ${rule.pattern}`
    );
    assert.match(source, /requireTenantAuth\(request, \{ minRole: "(user|admin)" \}\)/);
    assert.ok(
      source.includes(`minRole: "${rule.minRole}"`),
      `${rule.pattern} handler role matches the manifest`
    );
  }
  assert.equal(matchTenantRoute("get", "/api/tenant/me")?.pattern, "/api/tenant/me");
});

test("the manifest is pinned: adding a row needs a reviewed change here", () => {
  assert.deepEqual(
    TENANT_ROUTES.map((rule) => `${rule.method} ${rule.pattern} ${rule.minRole}`),
    [
      "GET /api/tenant/me user",
      "GET /api/tenant/users admin",
      "GET /api/tenant/keys admin",
      "GET /api/tenant/routing admin",
      "PUT /api/tenant/routing admin",
    ]
  );
  assert.ok(Object.isFrozen(TENANT_ROUTES));
});

// --- every management route ----------------------------------------------------------------------

test("NO management route accepts a tenant session (every route file, both read and write)", async () => {
  const { user } = await makeUser("admin");
  const cookie = await tenantCookie(user.id);
  const apiRoot = join(process.cwd(), "src/app/api");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts" || name === "route.js") files.push(full);
    }
  };
  walk(apiRoot);

  let checked = 0;
  const leaked: string[] = [];
  for (const file of files) {
    const rel = relative(join(process.cwd(), "src/app"), file.slice(0, file.lastIndexOf(sep)))
      .split(sep)
      .join("/");
    // Dynamic segments become a concrete value; catch-alls a plain word.
    const path = "/" + rel.replace(/\[\[?\.\.\.[^\]]+\]?\]/g, "x").replace(/\[[^\]]+\]/g, "x");
    if (path.startsWith("/api/tenant/") || path === "/api/tenant") continue;
    for (const method of ["GET", "POST"]) {
      if (classifyRoute(path, method).routeClass !== "MANAGEMENT") continue;
      checked += 1;
      const allowed = await pipelineAllows(path, {
        cookie,
        method,
        headers: { origin: "http://localhost" },
        ...(method === "POST" ? { body: {} } : {}),
      });
      if (allowed) leaked.push(`${method} ${path}`);
    }
  }
  assert.ok(checked > 300, `only ${checked} management routes were enumerated`);
  assert.deepEqual(leaked, [], "a tenant session got through to a management route");
});

// --- the second factor for tenant users ----------------------------------------------------------

test("a tenant user with a second factor gets a challenge, then a TENANT cookie (never a dashboard one)", async () => {
  const { user } = await makeUser("admin");
  const principal = `user:${user.id}`;
  const started = mfa.beginMfaSetup(principal)!;
  assert.ok(mfa.enableMfa(principal, totpCode(started.secret)));

  const first = await login(user.email, TENANT_PASSWORD);
  const body = (await first.json()) as { mfaRequired?: boolean; mfaToken?: string };
  assert.equal(body.mfaRequired, true);
  assert.equal(cookiesSet.length, 0, "no cookie before the second factor");

  getDbInstance().prepare("UPDATE auth_mfa SET last_used_step = 0").run();
  const done = await mfaVerifyRoute.POST(
    req("/api/auth/mfa/verify", {
      method: "POST",
      body: { mfaToken: body.mfaToken, code: totpCode(started.secret, Date.now() + 30_000) },
    })
  );
  assert.equal(done.status, 200);
  assert.equal(cookiesSet.length, 1);
  assert.equal(cookiesSet[0].name, "rr_tenant");
  assert.ok(await session.authenticateTenantToken(cookiesSet[0].value));
  assert.ok(!cookiesSet.some((cookie) => cookie.name === "auth_token"));
});

test("wrong second-factor codes lock the tenant bucket, not the owner's", async () => {
  const { user } = await makeUser();
  const principal = `user:${user.id}`;
  const started = mfa.beginMfaSetup(principal)!;
  assert.ok(mfa.enableMfa(principal, totpCode(started.secret)));
  const { mfaToken } = (await (await login(user.email, TENANT_PASSWORD)).json()) as {
    mfaToken: string;
  };
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    statuses.push(
      (
        await mfaVerifyRoute.POST(
          req("/api/auth/mfa/verify", { method: "POST", body: { mfaToken, code: "000000" } })
        )
      ).status
    );
  }
  assert.equal(statuses.at(-1), 429, `statuses: ${statuses}`);
  const owner = await ownerLoginRoute.POST(
    req("/api/auth/login", { method: "POST", body: { password: OWNER_PASSWORD } })
  );
  assert.equal(owner.status, 200);
});

// --- attribution ---------------------------------------------------------------------------------

test("audited actions of a tenant session are attributed to tenant/e-mail", async () => {
  const { user } = await makeUser("admin", "acme", "boss@acme.io");
  const cookie = await tenantCookie(user.id);
  assert.equal(await auditActorFor(req("/api/tenant/me", { cookie })), "tenant:acme/boss@acme.io");
});
