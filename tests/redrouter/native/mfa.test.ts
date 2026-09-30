import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

// The second factor end to end on a real database: setup, enable, password + code sign-in,
// replay protection, recovery codes, lockout, and disabling.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-mfa-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-mfa";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "mfa-test-secret";
delete process.env.INITIAL_PASSWORD;

const PASSWORD = "correct horse battery staple 42";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const {
  DASHBOARD_SESSION_COOKIE,
  getDashboardJwtSecret,
  mintDashboardSessionToken,
  verifyDashboardSessionToken,
} = await import("../../../src/shared/utils/dashboardSessionToken.ts");
const { totpCode } = await import("../../../src/lib/auth/totp.ts");
const { resetLoginGuardForTests } = await import("../../../src/server/auth/loginGuard.ts");
const { sessionCookieInternals } = await import("../../../src/lib/auth/dashboardSessionCookie.ts");
const loginRoute = await import("../../../src/app/api/auth/login/route.ts");
const verifyRoute = await import("../../../src/app/api/auth/mfa/verify/route.ts");
const stateRoute = await import("../../../src/app/api/settings/mfa/route.ts");
const setupRoute = await import("../../../src/app/api/settings/mfa/setup/route.ts");
const enableRoute = await import("../../../src/app/api/settings/mfa/enable/route.ts");
const disableRoute = await import("../../../src/app/api/settings/mfa/disable/route.ts");
const recoveryRoute = await import("../../../src/app/api/settings/mfa/recovery-codes/route.ts");

const cookiesSet: Array<{ name: string; value: string }> = [];
const recordingStore = async () => ({
  set(name: string, value: string) {
    cookiesSet.push({ name, value });
  },
});
loginRoute.authRouteInternals.getCookieStore = recordingStore as never;
sessionCookieInternals.getCookieStore = recordingStore as never;

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  cookiesSet.length = 0;
  getDbInstance().prepare("DELETE FROM auth_mfa").run();
  await updateSettings({ requireLogin: true, password: await hashManagementPassword(PASSWORD) });
  resetLoginGuardForTests();
});

async function sessionCookie() {
  return `${DASHBOARD_SESSION_COOKIE}=${await mintDashboardSessionToken(getDashboardJwtSecret()!)}`;
}

async function post(
  handler: (request: NextRequest) => Promise<Response>,
  path: string,
  body: unknown,
  session = false
) {
  return handler(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: await sessionCookie() } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

const login = (password = PASSWORD) => post(loginRoute.POST, "/api/auth/login", { password });
const verify = (body: Record<string, unknown>) =>
  post(verifyRoute.POST, "/api/auth/mfa/verify", body);

/** Turns the second factor on and returns its secret and recovery codes. */
async function enroll() {
  const started = (await (
    await post(setupRoute.POST, "/api/settings/mfa/setup", {}, true)
  ).json()) as {
    secret: string;
  };
  // Enabling records this step, so sign-in codes must come from the next one (within the window).
  const enabled = await post(
    enableRoute.POST,
    "/api/settings/mfa/enable",
    { code: totpCode(started.secret) },
    true
  );
  assert.equal(enabled.status, 200);
  const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] };
  return { secret: started.secret, recoveryCodes };
}

const nextStepCode = (secret: string, ahead = 1) => totpCode(secret, Date.now() + ahead * 30_000);
const forgetUsedStep = () =>
  getDbInstance().prepare("UPDATE auth_mfa SET last_used_step = 0").run();

test("without a second factor, sign-in is unchanged", async () => {
  const res = await login();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(cookiesSet.at(-1)?.name, "auth_token");
});

test("the setup, enable and state endpoints need a management session", async () => {
  assert.equal(
    (await stateRoute.GET(new Request("http://localhost/api/settings/mfa"))).status,
    401
  );
  assert.equal((await post(setupRoute.POST, "/api/settings/mfa/setup", {})).status, 401);
  assert.equal(
    (await post(enableRoute.POST, "/api/settings/mfa/enable", { code: "123456" })).status,
    401
  );
  assert.equal(
    (await post(disableRoute.POST, "/api/settings/mfa/disable", { code: "1" })).status,
    401
  );
  assert.equal(
    (await post(recoveryRoute.POST, "/api/settings/mfa/recovery-codes", { code: "1" })).status,
    401
  );
});

test("setup does not gate sign-in until a valid code confirms the authenticator", async () => {
  const setup = await post(setupRoute.POST, "/api/settings/mfa/setup", {}, true);
  const body = (await setup.json()) as { secret: string; otpauthUri: string };
  assert.match(body.otpauthUri, /^otpauth:\/\/totp\/RedRouter:owner\?/);
  assert.equal((await login()).status, 200, "still a plain sign-in while pending");

  const wrong = await post(enableRoute.POST, "/api/settings/mfa/enable", { code: "000000" }, true);
  assert.equal(wrong.status, 400);
  const state = (await (
    await stateRoute.GET(
      new Request("http://localhost/api/settings/mfa", {
        headers: { cookie: await sessionCookie() },
      })
    )
  ).json()) as Record<string, unknown>;
  assert.equal(state.enabled, false);
  assert.equal(state.pendingSetup, true);
  assert.ok(!JSON.stringify(state).includes(body.secret), "the state never carries the secret");
});

test("with the second factor on, the password only earns a challenge, not a session", async () => {
  const { secret } = await enroll();
  cookiesSet.length = 0;
  const res = await login();
  const body = (await res.json()) as {
    mfaRequired?: boolean;
    mfaToken?: string;
    success?: boolean;
  };
  assert.equal(res.status, 200);
  assert.equal(body.mfaRequired, true);
  assert.equal(body.success, undefined);
  assert.equal(cookiesSet.length, 0, "no cookie before the second factor");
  assert.equal(
    await verifyDashboardSessionToken(body.mfaToken, getDashboardJwtSecret()),
    null,
    "the challenge is not a session"
  );

  forgetUsedStep();
  const done = await verify({ mfaToken: body.mfaToken, code: nextStepCode(secret) });
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { method: string }).method, "totp");
  assert.equal(cookiesSet.at(-1)?.name, "auth_token");
  assert.ok(await verifyDashboardSessionToken(cookiesSet.at(-1)!.value, getDashboardJwtSecret()));
});

test("a wrong password never reveals or issues a challenge", async () => {
  await enroll();
  const res = await login("not the password");
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as Record<string, unknown>).mfaToken, undefined);
});

test("a code cannot be replayed, and a spent challenge cannot be reused", async () => {
  const { secret } = await enroll();
  const first = (await (await login()).json()) as { mfaToken: string };
  forgetUsedStep();
  const code = nextStepCode(secret);
  assert.equal((await verify({ mfaToken: first.mfaToken, code })).status, 200);

  // Same challenge again: spent.
  const reuse = await verify({ mfaToken: first.mfaToken, code: nextStepCode(secret) });
  assert.equal(reuse.status, 401);
  assert.equal(((await reuse.json()) as { restart?: boolean }).restart, true);

  // A fresh challenge with the SAME code: that step was already used.
  const second = (await (await login()).json()) as { mfaToken: string };
  assert.equal((await verify({ mfaToken: second.mfaToken, code })).status, 401);
});

test("recovery codes work once each", async () => {
  const { recoveryCodes } = await enroll();
  const one = (await (await login()).json()) as { mfaToken: string };
  const ok = await verify({ mfaToken: one.mfaToken, recoveryCode: recoveryCodes[0].toUpperCase() });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { method: string }).method, "recovery");

  const two = (await (await login()).json()) as { mfaToken: string };
  assert.equal(
    (await verify({ mfaToken: two.mfaToken, recoveryCode: recoveryCodes[0] })).status,
    401
  );
  assert.equal(
    (await verify({ mfaToken: two.mfaToken, recoveryCode: recoveryCodes[1] })).status,
    200
  );
  const state = (await (
    await stateRoute.GET(
      new Request("http://localhost/api/settings/mfa", {
        headers: { cookie: await sessionCookie() },
      })
    )
  ).json()) as { recoveryCodesRemaining: number };
  assert.equal(state.recoveryCodesRemaining, 8);
});

test("garbage, expired-shaped and foreign tokens are refused", async () => {
  await enroll();
  for (const token of [
    "",
    "abc",
    "a.b.c",
    await mintDashboardSessionToken(getDashboardJwtSecret()!),
  ]) {
    const res = await verify({ mfaToken: token, code: "123456" });
    assert.ok([400, 401].includes(res.status), token.slice(0, 8));
    assert.equal(cookiesSet.length, 0);
  }
});

test("failed codes lock sign-in out, and re-entering the password does not reset the count", async () => {
  await enroll();
  const { mfaToken } = (await (await login()).json()) as { mfaToken: string };
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push((await verify({ mfaToken, code: "000000" })).status);
  }
  assert.equal(statuses.at(-1), 429, `statuses: ${statuses}`);
  const locked = await login();
  assert.equal(locked.status, 429, "the lockout also stops the password step");
});

test("disabling needs the password and a code", async () => {
  const { secret } = await enroll();
  const disable = (body: Record<string, unknown>) =>
    post(disableRoute.POST, "/api/settings/mfa/disable", body, true);
  forgetUsedStep();
  assert.equal((await disable({ code: nextStepCode(secret) })).status, 400, "no password");
  assert.equal(
    (await disable({ password: "wrong password here", code: nextStepCode(secret) })).status,
    400
  );
  assert.equal((await disable({ password: PASSWORD, code: "000000" })).status, 400, "bad code");
  assert.equal((await disable({ password: PASSWORD, code: nextStepCode(secret) })).status, 200);
  assert.equal((await login()).status, 200);
  assert.deepEqual(cookiesSet.at(-1)?.name, "auth_token");
});

test("regenerating recovery codes invalidates the old ones", async () => {
  const { secret, recoveryCodes } = await enroll();
  forgetUsedStep();
  const res = await post(
    recoveryRoute.POST,
    "/api/settings/mfa/recovery-codes",
    { code: nextStepCode(secret) },
    true
  );
  assert.equal(res.status, 200);
  const fresh = ((await res.json()) as { recoveryCodes: string[] }).recoveryCodes;
  assert.equal(fresh.length, 10);
  const { mfaToken } = (await (await login()).json()) as { mfaToken: string };
  assert.equal((await verify({ mfaToken, recoveryCode: recoveryCodes[0] })).status, 401);
  assert.equal((await verify({ mfaToken, recoveryCode: fresh[0] })).status, 200);
});

test("the secret is encrypted at rest and setup is refused while enabled", async () => {
  const { secret } = await enroll();
  const row = getDbInstance().prepare("SELECT secret_encrypted FROM auth_mfa").get() as {
    secret_encrypted: string;
  };
  if (process.env.STORAGE_ENCRYPTION_KEY) assert.ok(!row.secret_encrypted.includes(secret));
  assert.equal((await post(setupRoute.POST, "/api/settings/mfa/setup", {}, true)).status, 409);
});
