import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-oidc-hardening-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-oidc-hardening";

const core = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const flow = await import("../../../src/lib/auth/oidcFlow.ts");
const loginRoute = await import("../../../src/app/api/auth/oidc/login/route.ts");
const callbackRoute = await import("../../../src/app/api/auth/oidc/callback/route.ts");
const testRoute = await import("../../../src/app/api/auth/oidc/test/route.ts");

const originalFetch = globalThis.fetch;
const originalCookieStore = callbackRoute.oidcCallbackInternals.getCookieStore;
let cookies: Record<string, { value: string; options?: Record<string, unknown> }> = {};

beforeEach(async () => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  cookies = {};
  callbackRoute.oidcCallbackInternals.clearJwksCache?.();
  callbackRoute.oidcCallbackInternals.getCookieStore = (async () => ({
    get: (name: string) => (cookies[name] ? { value: cookies[name].value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookies[name] = { value, options };
    },
  })) as never;
  await updateSettings({
    requireLogin: true,
    password: "",
    oidcEnabled: true,
    oidcIssuer: "https://idp.test",
    oidcClientId: "client-1",
    oidcClientSecret: "secret-1",
    oidcRedirectPath: "/api/auth/oidc/callback",
    oidcAllowedSubjects: ["user-1"],
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  callbackRoute.oidcCallbackInternals.getCookieStore = originalCookieStore;
});

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("PKCE pairs are S256 of a fresh verifier and state/nonce never repeat", () => {
  const a = flow.createPkcePair();
  const b = flow.createPkcePair();
  assert.ok(a.verifier.length >= 43 && a.verifier.length <= 128);
  assert.match(a.verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.challenge, flow.pkceChallengeFor(a.verifier));
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(flow.createOidcState(), flow.createOidcState());
  assert.notEqual(flow.createOidcNonce(), flow.createOidcNonce());
});

test("the authorization request carries PKCE, a nonce and state, each bound to a cookie", async () => {
  globalThis.fetch = (async () => new Response("no", { status: 404 })) as never;
  const response = await loginRoute.GET(new Request("http://localhost/api/auth/oidc/login"));
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location") as string);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  const setCookie = response.headers.getSetCookie().join("\n");
  const cookie = (name: string) => new RegExp(`${name}=([^;]+)`).exec(setCookie)?.[1];
  assert.equal(location.searchParams.get("state"), cookie(flow.OIDC_STATE_COOKIE));
  assert.equal(location.searchParams.get("nonce"), cookie(flow.OIDC_NONCE_COOKIE));
  assert.equal(
    location.searchParams.get("code_challenge"),
    flow.pkceChallengeFor(cookie(flow.OIDC_VERIFIER_COOKIE) as string)
  );
  assert.match(setCookie, /HttpOnly/i);
  assert.equal(cookie(flow.OIDC_TEST_COOKIE), undefined);
});

test("a test sign-in cannot be started without a session", async () => {
  const response = await loginRoute.GET(new Request("http://localhost/api/auth/oidc/login?test=1"));
  assert.equal(response.status, 401);
});

async function signedIdToken(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { idToken, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "k1" }] } };
}

function mockIdp(idToken: string, jwks: unknown, seen: { tokenBody?: URLSearchParams } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openid-configuration")) {
      return Response.json({
        issuer: "https://idp.test",
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
      });
    }
    if (url.endsWith("/token")) {
      seen.tokenBody = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: idToken });
    }
    if (url.endsWith("/jwks")) return Response.json(jwks);
    return new Response("nope", { status: 404 });
  }) as never;
  return seen;
}

const callback = () =>
  callbackRoute.GET(
    new Request("http://localhost/api/auth/oidc/callback?code=c1&state=s1", {
      headers: { "x-forwarded-proto": "http" },
    })
  );

test("the callback sends the PKCE verifier and accepts a matching nonce", async () => {
  const { idToken, jwks } = await signedIdToken({
    iss: "https://idp.test",
    aud: "client-1",
    sub: "user-1",
    nonce: "n1",
  });
  const seen = mockIdp(idToken, jwks);
  cookies = {
    [flow.OIDC_STATE_COOKIE]: { value: "s1" },
    [flow.OIDC_NONCE_COOKIE]: { value: "n1" },
    [flow.OIDC_VERIFIER_COOKIE]: { value: "verifier-1" },
  };
  const response = await callback();
  assert.ok(response.headers.get("location")?.endsWith("/dashboard"));
  assert.equal(seen.tokenBody?.get("code_verifier"), "verifier-1");
  assert.ok(cookies.auth_token, "a session is opened");
  assert.equal(cookies[flow.OIDC_NONCE_COOKIE].value, "", "the flow cookies are single use");
});

test("an ID token whose nonce is not ours is refused", async () => {
  for (const nonce of ["other", undefined]) {
    const { idToken, jwks } = await signedIdToken({
      iss: "https://idp.test",
      aud: "client-1",
      sub: "user-1",
      ...(nonce ? { nonce } : {}),
    });
    mockIdp(idToken, jwks);
    cookies = {
      [flow.OIDC_STATE_COOKIE]: { value: "s1" },
      [flow.OIDC_NONCE_COOKIE]: { value: "n1" },
    };
    const response = await callback();
    assert.match(response.headers.get("location") ?? "", /oidc_error=id_token_invalid/);
    assert.equal(cookies.auth_token, undefined);
    core.resetDbInstance();
  }
});

test("a test sign-in reports back to Settings, opens no session and stamps the success", async () => {
  const { idToken, jwks } = await signedIdToken({
    iss: "https://idp.test",
    aud: "client-1",
    sub: "user-1",
    nonce: "n1",
  });
  mockIdp(idToken, jwks);
  cookies = {
    [flow.OIDC_STATE_COOKIE]: { value: "s1" },
    [flow.OIDC_NONCE_COOKIE]: { value: "n1" },
    [flow.OIDC_TEST_COOKIE]: { value: "1" },
  };
  const response = await callback();
  assert.match(response.headers.get("location") ?? "", /\/dashboard\/settings\/security\?oidc_test=ok/);
  assert.equal(cookies.auth_token, undefined, "a test never opens a session");
  assert.equal(typeof (await getSettings())[flow.OIDC_LAST_TEST_SETTING], "string");
});

test("a test sign-in as someone off the allow list fails without a stamp", async () => {
  const { idToken, jwks } = await signedIdToken({
    iss: "https://idp.test",
    aud: "client-1",
    sub: "intruder",
    nonce: "n1",
  });
  mockIdp(idToken, jwks);
  cookies = {
    [flow.OIDC_STATE_COOKIE]: { value: "s1" },
    [flow.OIDC_NONCE_COOKIE]: { value: "n1" },
    [flow.OIDC_TEST_COOKIE]: { value: "1" },
  };
  const response = await callback();
  assert.match(response.headers.get("location") ?? "", /oidc_test=subject_not_allowed/);
  assert.equal((await getSettings())[flow.OIDC_LAST_TEST_SETTING] ?? null, null);
});

const runConnectionTest = () =>
  testRoute.POST(new Request("http://localhost/api/auth/oidc/test", { method: "POST" }));

function mockTokenEndpoint(status: number, body: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("openid-configuration")) {
      return Response.json({
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        jwks_uri: "https://idp.test/jwks",
      });
    }
    return Response.json(body, { status });
  }) as never;
}

test("the connection test needs a management session", async () => {
  const response = await runConnectionTest();
  assert.equal(response.status, 401);
});

test("the connection test accepts a client the provider authenticates", async () => {
  await updateSettings({ requireLogin: false });
  mockTokenEndpoint(400, { error: "invalid_grant", error_description: "secret-detail" });
  const result = await (await runConnectionTest()).json();
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes("secret-detail"), "provider text is never echoed");
  assert.ok(!JSON.stringify(result).includes("secret-1"));
});

test("the connection test flags a rejected client and a missing configuration", async () => {
  await updateSettings({ requireLogin: false });
  mockTokenEndpoint(401, { error: "invalid_client" });
  const rejected = await (await runConnectionTest()).json();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.checks.find((c: { name: string }) => c.name === "client").ok, false);

  await updateSettings({ oidcIssuer: "" });
  const missing = await (await runConnectionTest()).json();
  assert.equal(missing.ok, false);
  assert.equal(missing.checks[0].name, "configuration");
});

const settingsRoute = await import("../../../src/app/api/settings/route.ts");
const patch = (body: unknown) =>
  settingsRoute.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("password login cannot be switched off before an OIDC test sign-in succeeded", async () => {
  await updateSettings({ requireLogin: false });
  const blocked = await patch({ oidcDisablePasswordLogin: true });
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).error.code, "OIDC_TEST_REQUIRED");
  assert.equal((await getSettings()).oidcDisablePasswordLogin, false);
});

test("after a successful test sign-in the guard steps aside, and changing the setup clears it", async () => {
  await updateSettings({ requireLogin: false, [flow.OIDC_LAST_TEST_SETTING]: "2026-09-29T00:00:00Z" });
  const allowed = await patch({ oidcDisablePasswordLogin: true });
  const body = await allowed.json().catch(() => ({}));
  assert.notEqual(body?.error?.code, "OIDC_TEST_REQUIRED");

  // Saving the same configuration keeps the stamp; a real change makes it stale.
  await patch({ oidcIssuer: "https://idp.test" });
  assert.equal(typeof (await getSettings())[flow.OIDC_LAST_TEST_SETTING], "string");
  await patch({ oidcIssuer: "https://other-idp.test" });
  assert.equal((await getSettings())[flow.OIDC_LAST_TEST_SETTING] ?? null, null);
});
