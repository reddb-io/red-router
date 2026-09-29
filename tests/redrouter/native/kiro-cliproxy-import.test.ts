import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Scratch install with no login so the management gate lets calls in; the last test turns
// login on to prove non-management callers are refused.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-kiro-cliproxy-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "kiro-cliproxy-api-key-secret";
process.env.JWT_SECRET = "kiro-cliproxy-jwt-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getProviderConnections } = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { normalizeKiroExternalIdpAuth } = await import("../../../src/lib/oauth/kiroExternalIdp.ts");
const { parseCliProxyAuthRecord, toConnectionPayload, CLIPROXY_TYPE_TO_PROVIDER } =
  await import("../../../src/lib/oauth/utils/cliProxyAuthImport.ts");
const route = await import("../../../src/app/api/oauth/kiro/import-cli-proxy/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const CLIENT_ID = "00000000-0000-4000-8000-000000000000";
const SCOPE = `api://${CLIENT_ID}/codewhisperer:conversations offline_access`;
const ENDPOINT = "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token";
const PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC";
const REFRESH = "1.AcY-secret-refresh-token";
const NOW = 1_700_000_000_000;

function makeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const ACCESS = makeJwt({ preferred_username: "user@example.com", exp: NOW / 1000 + 3600 });

const base = (extra: Record<string, unknown> = {}) => ({
  type: "kiro",
  auth_method: "external_idp",
  access_token: ACCESS,
  refresh_token: REFRESH,
  client_id: CLIENT_ID,
  token_endpoint: ENDPOINT,
  profile_arn: PROFILE,
  region: "us-east-1",
  scopes: SCOPE,
  ...extra,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/oauth/kiro/import-cli-proxy", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ------------------------------------------------------------------ normalizer / parser

test("normalizer builds the External IdP connection fields from a CLIProxyAPI file", () => {
  const data = normalizeKiroExternalIdpAuth(base({ expired: "2030-01-01T00:00:00Z" }), NOW);
  assert.equal(data.accessToken, ACCESS);
  assert.equal(data.refreshToken, REFRESH);
  assert.equal(data.email, "user@example.com");
  assert.equal(data.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(data.providerSpecificData, {
    profileArn: PROFILE,
    region: "us-east-1",
    authMethod: "external_idp",
    provider: "CLIProxyAPI",
    clientId: CLIENT_ID,
    tokenEndpoint: ENDPOINT,
    scope: SCOPE,
  });
});

test("normalizer accepts pasted JSON text, array scopes and defaults the region", () => {
  const data = normalizeKiroExternalIdpAuth(
    JSON.stringify(base({ region: undefined, scopes: ["a", " b ", ""] })),
    NOW
  );
  assert.equal(data.providerSpecificData.region, "us-east-1");
  assert.equal(data.providerSpecificData.scope, "a b");
});

test("normalizer derives expiry from the JWT and treats a missing access token as expired", () => {
  assert.equal(
    normalizeKiroExternalIdpAuth(base(), NOW).expiresAt,
    new Date(NOW + 3600_000).toISOString()
  );
  const noAccess = normalizeKiroExternalIdpAuth(base({ access_token: undefined }), NOW);
  assert.equal(noAccess.accessToken, "");
  assert.equal(noAccess.email, null);
  assert.equal(noAccess.expiresAt, new Date(NOW).toISOString());
});

test("normalizer rejects other auth methods, foreign endpoints and missing fields", () => {
  const failures: Array<[Record<string, unknown>, RegExp]> = [
    [base({ auth_method: "social" }), /Only external_idp/],
    [base({ auth_method: undefined }), /Only external_idp/],
    [base({ token_endpoint: "https://evil.example.com/token" }), /token_endpoint must be/],
    [base({ token_endpoint: "http://login.microsoftonline.com/x" }), /token_endpoint must be/],
    [base({ token_endpoint: undefined }), /token_endpoint must be/],
    [base({ scopes: undefined }), /scopes is required/],
    [base({ profile_arn: undefined }), /profile_arn is required/],
    [base({ refresh_token: undefined }), /refresh_token is required/],
    [base({ client_id: undefined }), /client_id is required/],
  ];
  for (const [input, message] of failures) {
    assert.throws(() => normalizeKiroExternalIdpAuth(input, NOW), message);
  }
  assert.throws(() => normalizeKiroExternalIdpAuth("{not json", NOW), /invalid/);
  assert.throws(() => normalizeKiroExternalIdpAuth([], NOW), /required/);
});

test("normalizer errors never echo submitted values", () => {
  try {
    normalizeKiroExternalIdpAuth(
      base({ token_endpoint: "https://evil-host-123.example/token" }),
      NOW
    );
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(!String((error as Error).message).includes("evil-host-123"));
  }
});

test("CLIProxyAPI scan parser maps type kiro and skips non external_idp files", () => {
  assert.equal(CLIPROXY_TYPE_TO_PROVIDER.kiro, "kiro");
  const parsed = parseCliProxyAuthRecord(base({ access_token: undefined }), NOW);
  assert.equal(parsed?.provider, "kiro");
  assert.equal(parsed?.accessToken, "");
  assert.equal(parsed?.refreshToken, REFRESH);
  assert.equal(parsed?.expiresAt, new Date(NOW).toISOString());
  assert.equal(parsed?.providerSpecificData?.authMethod, "external_idp");
  assert.equal(parsed?.providerSpecificData?.importedFrom, "cliproxyapi");

  assert.equal(parseCliProxyAuthRecord(base({ auth_method: "social" }), NOW), null);
  assert.equal(
    parseCliProxyAuthRecord(base({ token_endpoint: "https://evil.example.com/t" }), NOW),
    null
  );
  assert.equal(parseCliProxyAuthRecord({ type: "kiro", access_token: "x" }, NOW), null);

  const payload = toConnectionPayload(parsed!);
  assert.equal(payload.provider, "kiro");
  assert.equal(payload.authType, "oauth");
  assert.equal((payload.providerSpecificData as Record<string, unknown>).profileArn, PROFILE);
});

// ------------------------------------------------------------------ route

test("route imports external_idp JSON as a kiro connection without echoing tokens", async () => {
  for (const body of [{ cliProxyAuth: base() }, base()]) {
    const res = await route.POST(post(body));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(REFRESH) && !text.includes(ACCESS), "tokens must not be echoed");
    const json = JSON.parse(text);
    assert.equal(json.success, true);
    assert.equal(json.connection.provider, "kiro");
    assert.equal(json.connection.email, "user@example.com");
  }

  // Both submissions are the same account: the second updated the first in place.
  const stored = await getProviderConnections({ provider: "kiro" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authType, "oauth");
  assert.equal(stored[0].accessToken, ACCESS);
  assert.equal(stored[0].refreshToken, REFRESH);
  assert.equal(stored[0].email, "user@example.com");
  assert.equal(stored[0].testStatus, "active");
  const psd = stored[0].providerSpecificData;
  assert.equal(psd.authMethod, "external_idp");
  assert.equal(psd.provider, "CLIProxyAPI");
  assert.equal(psd.profileArn, PROFILE);
  assert.equal(psd.clientId, CLIENT_ID);
  assert.equal(psd.tokenEndpoint, ENDPOINT);
  assert.equal(psd.scope, SCOPE);
});

test("route accepts pasted JSON text and a file without an access token", async () => {
  const other = base({
    access_token: undefined,
    client_id: "11111111-1111-4111-8111-111111111111",
    email: "second@example.com",
  });
  const res = await route.POST(post({ json: JSON.stringify(other) }));
  assert.equal(res.status, 200);
  const stored = await getProviderConnections({ provider: "kiro" });
  const second = stored.find((connection) => connection.email === "second@example.com");
  assert.ok(second);
  assert.ok(!second.accessToken);
  assert.equal(second.refreshToken, REFRESH);
  assert.equal(stored.length, 2);
});

test("route rejects invalid input with fixed messages and stores nothing", async () => {
  const before = (await getProviderConnections({ provider: "kiro" })).length;
  const cases: Array<[unknown, RegExp]> = [
    [base({ auth_method: "social" }), /Only external_idp/],
    [base({ token_endpoint: "https://evil.example.com/token" }), /token_endpoint must be/],
    [base({ scopes: undefined }), /scopes is required/],
    [base({ profile_arn: undefined }), /profile_arn is required/],
    [{ cliProxyAuth: "{not json" }, /invalid/],
    [{}, /Only external_idp/],
  ];
  for (const [body, message] of cases) {
    const res = await route.POST(post(body));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    const text = await res.text();
    assert.match(text, message);
    assert.ok(!text.includes(REFRESH));
  }
  for (const body of ["not json", "[]", '"x"']) {
    assert.equal((await route.POST(post(body))).status, 400, body);
  }
  const oversized = await route.POST(post(base({ padding: "x".repeat(1_100_000) })));
  assert.equal(oversized.status, 413);
  assert.equal((await getProviderConnections({ provider: "kiro" })).length, before);
});

test("route refuses callers without management authorization", async () => {
  await updateSettings({ requireLogin: true, password: "configured-password-hash" });
  const plain = await apiKeysDb.createApiKey("inference-only", "machine1234567890");
  const before = (await getProviderConnections({ provider: "kiro" })).length;

  assert.equal((await route.POST(post(base()))).status, 401);
  const unknownKey = await route.POST(post(base(), { authorization: "Bearer sk-not-real" }));
  assert.equal(unknownKey.status, 401);
  const clientKey = await route.POST(post(base(), { authorization: `Bearer ${plain.key}` }));
  assert.equal(clientKey.status, 403);

  assert.equal((await getProviderConnections({ provider: "kiro" })).length, before);
});
