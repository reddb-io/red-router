import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

// Scratch install: a fresh DB with no login configured, so the management gate lets the call
// in; the last test turns login on to prove a plain client API key is refused.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-credential-imports-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "credential-imports-api-key-secret";
process.env.JWT_SECRET = "credential-imports-jwt-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getProviderConnections } = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { gitLabPatNetwork } = await import("../../../src/lib/oauth/utils/credentialImports.ts");
const gitlabRoute = await import("../../../src/app/api/oauth/gitlab/pat/route.ts");
const iflowRoute = await import("../../../src/app/api/oauth/iflow/cookie/route.ts");
const grokRoute = await import("../../../src/app/api/oauth/grok-cli/bulk-import/route.ts");

const originalFetch = globalThis.fetch;
let outbound: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  outbound = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  globalThis.fetch = impl;
  return impl;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  gitLabPatNetwork.lookup = undefined;
  gitLabPatNetwork.fetchImpl = undefined;
  outbound = [];
});

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/oauth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PUBLIC_LOOKUP = async () => [{ address: "203.0.113.10", family: 4 }];

function useGitLab(handler: (url: string, init?: RequestInit) => Response) {
  gitLabPatNetwork.lookup = PUBLIC_LOOKUP;
  gitLabPatNetwork.fetchImpl = mockFetch(handler);
}

// --------------------------------------------------------------------------- GitLab PAT

test("gitlab/pat verifies the token and stores a gitlab-duo connection without echoing it", async () => {
  const TOKEN = "glpat-super-secret-token";
  useGitLab(() => json(200, { username: "ada", name: "Ada L", email: "ada@example.com", id: 7 }));

  const res = await gitlabRoute.POST(
    post("gitlab/pat", { token: TOKEN, baseUrl: "https://gitlab.example.com/" })
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(TOKEN), "response must not echo the token");
  const body = JSON.parse(text);
  assert.equal(body.success, true);
  assert.equal(body.connection.provider, "gitlab-duo");
  assert.equal(body.connection.email, "ada@example.com");

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, "https://gitlab.example.com/api/v4/user");
  assert.equal((outbound[0].init?.headers as Record<string, string>)["Private-Token"], TOKEN);

  const stored = await getProviderConnections({ provider: "gitlab-duo" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authType, "oauth");
  assert.equal(stored[0].accessToken, TOKEN);
  assert.equal(stored[0].refreshToken ?? null, null);
  assert.equal(stored[0].email, "ada@example.com");
  assert.equal(stored[0].providerSpecificData.authKind, "personal_access_token");
  assert.equal(stored[0].providerSpecificData.baseUrl, "https://gitlab.example.com");
  assert.equal(stored[0].providerSpecificData.username, "ada");
});

test("gitlab/pat rejects invalid bodies with 400 and makes no outbound call", async () => {
  useGitLab(() => json(200, {}));
  for (const body of [{}, { token: "" }, { token: "x".repeat(600) }, { token: 5 }, "not json"]) {
    const res = await gitlabRoute.POST(post("gitlab/pat", body));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(outbound.length, 0);
});

test("gitlab/pat refuses private, loopback, metadata, IP-literal and non-https base URLs", async () => {
  useGitLab(() => json(200, { username: "x" }));
  const blocked = [
    "http://gitlab.example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://10.0.0.5",
    "https://169.254.169.254",
    "https://8.8.8.8",
    "https://localhost",
    "https://metadata.google.internal",
    "https://user:pass@gitlab.example.com",
    "ftp://gitlab.example.com",
  ];
  for (const baseUrl of blocked) {
    const res = await gitlabRoute.POST(post("gitlab/pat", { token: "glpat-x", baseUrl }));
    assert.ok([400, 502].includes(res.status), `${baseUrl} answered ${res.status}`);
  }
  assert.equal(outbound.length, 0, "no request may leave for a blocked host");
});

test("gitlab/pat refuses a public-looking name that resolves to a private address", async () => {
  gitLabPatNetwork.lookup = async () => [{ address: "10.1.2.3", family: 4 }];
  gitLabPatNetwork.fetchImpl = mockFetch(() => json(200, { username: "x" }));
  const res = await gitlabRoute.POST(
    post("gitlab/pat", { token: "glpat-x", baseUrl: "https://rebind.example.com" })
  );
  assert.equal(res.status, 502);
  assert.equal(outbound.length, 0);
});

test("gitlab/pat maps an upstream 401 to a clean 401 without upstream text", async () => {
  useGitLab(
    () =>
      new Response("UPSTREAM-SECRET-DETAIL glpat-leak", {
        status: 401,
        headers: { "content-type": "text/plain" },
      })
  );
  const res = await gitlabRoute.POST(
    post("gitlab/pat", { token: "glpat-bad", baseUrl: "https://gitlab.example.com" })
  );
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes("UPSTREAM-SECRET-DETAIL"));
  assert.ok(!text.includes("glpat-"));
});

test("gitlab/pat does not follow redirects to another host", async () => {
  useGitLab(
    () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/x" } })
  );
  const res = await gitlabRoute.POST(
    post("gitlab/pat", { token: "glpat-x", baseUrl: "https://gitlab.example.com" })
  );
  assert.equal(res.status, 502);
  assert.equal(outbound.length, 1);
});

// --------------------------------------------------------------------------- iFlow cookie

test("iflow/cookie exchanges the cookie for an API key and stores a cookie connection", async () => {
  const API_KEY = "sk-iflow-secret-key-123456";
  mockFetch((url, init) => {
    assert.equal(url, "https://platform.iflow.cn/api/openapi/apikey");
    if (init?.method === "GET") return json(200, { success: true, data: { name: "my-key" } });
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "my-key" });
    return json(200, {
      success: true,
      data: { name: "my-key", apiKey: API_KEY, expireTime: "2027-01-01 00:00:00" },
    });
  });

  const res = await iflowRoute.POST(post("iflow/cookie", { cookie: "foo=1; BXAuth=abc123" }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(API_KEY) && !text.includes("abc123"));
  const body = JSON.parse(text);
  assert.equal(body.success, true);
  assert.equal(body.connection.provider, "iflow");
  assert.equal(body.connection.name, "my-key");

  assert.deepEqual(
    outbound.map((call) => call.init?.method),
    ["GET", "POST"]
  );
  assert.equal(
    (outbound[0].init?.headers as Record<string, string>).Cookie,
    "foo=1; BXAuth=abc123;"
  );

  const stored = await getProviderConnections({ provider: "iflow" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authType, "cookie");
  assert.equal(stored[0].apiKey, API_KEY);
  assert.equal(stored[0].providerSpecificData.cookie, "BXAuth=abc123;");
  assert.equal(stored[0].providerSpecificData.expireTime, "2027-01-01 00:00:00");
});

test("iflow/cookie rejects a missing BXAuth field and bad bodies with 400", async () => {
  mockFetch(() => json(200, { success: true, data: {} }));
  for (const body of [
    { cookie: "foo=1; bar=2" },
    { cookie: "BXAuth=" },
    { cookie: "" },
    {},
    "x{",
  ]) {
    const res = await iflowRoute.POST(post("iflow/cookie", body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const injected = await iflowRoute.POST(post("iflow/cookie", { cookie: "BXAuth=a\r\nX-Evil: 1" }));
  assert.equal(injected.status, 400);
  assert.equal(outbound.length, 0);
});

test("iflow/cookie maps an upstream 401 to a clean 401 without upstream text", async () => {
  mockFetch(() => new Response("iFlow says: session BXAuth=abc expired", { status: 401 }));
  const res = await iflowRoute.POST(post("iflow/cookie", { cookie: "BXAuth=abc" }));
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes("expired") && !text.includes("BXAuth=abc"));
  assert.equal(outbound.length, 1);
});

test("iflow/cookie treats success:false and a network failure as clean errors", async () => {
  mockFetch(() => json(200, { success: false, message: "UPSTREAM-MESSAGE" }));
  const rejected = await iflowRoute.POST(post("iflow/cookie", { cookie: "BXAuth=abc" }));
  assert.equal(rejected.status, 401);
  assert.ok(!(await rejected.text()).includes("UPSTREAM-MESSAGE"));

  mockFetch(() => {
    throw new Error("connect ECONNREFUSED 10.0.0.1:443");
  });
  const down = await iflowRoute.POST(post("iflow/cookie", { cookie: "BXAuth=abc" }));
  assert.equal(down.status, 502);
  assert.ok(!(await down.text()).includes("ECONNREFUSED"));
});

// --------------------------------------------------------------------------- Grok bulk

function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

test("grok-cli/bulk-import returns per-item results without tokens and stores the good ones", async () => {
  const access1 = fakeJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 });
  const access2 = fakeJwt({ sub: "u2" });
  const id1 = fakeJwt({ email: "one@example.com" });
  const refresh1 = "refresh-token-one-secret";

  const res = await grokRoute.POST(
    post("grok-cli/bulk-import", {
      items: [
        { access_token: access1, refresh_token: refresh1, id_token: id1, expires_in: 3600 },
        { accessToken: access2, refreshToken: "refresh-two", email: "two@example.com" },
        { access_token: "not-a-jwt" },
        42,
        {},
      ],
    })
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const secret of [access1, access2, refresh1, id1, "refresh-two"]) {
    assert.ok(!text.includes(secret), "no token may appear in the response");
  }
  const body = JSON.parse(text);
  assert.equal(body.total, 5);
  assert.equal(body.success, 2);
  assert.equal(body.failed, 3);
  assert.deepEqual(
    body.results.map((r: { index: number; ok: boolean }) => [r.index, r.ok]),
    [
      [0, true],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]
  );
  assert.equal(body.results[0].email, "one@example.com");
  assert.equal(body.results[1].email, "two@example.com");
  assert.ok(body.results[0].id);
  assert.ok(body.results[2].error);

  const stored = await getProviderConnections({ provider: "grok-cli" });
  assert.equal(stored.length, 2);
  const one = stored.find((c: { email?: string }) => c.email === "one@example.com");
  assert.equal(one.accessToken, access1);
  assert.equal(one.refreshToken, refresh1);
  assert.equal(one.authType, "oauth");
});

test("grok-cli/bulk-import re-importing the same email updates instead of duplicating", async () => {
  const before = (await getProviderConnections({ provider: "grok-cli" })).length;
  const res = await grokRoute.POST(
    post("grok-cli/bulk-import", {
      items: [{ accessToken: fakeJwt({ sub: "u2b" }), email: "two@example.com" }],
    })
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, 1);
  assert.equal((await getProviderConnections({ provider: "grok-cli" })).length, before);
});

test("grok-cli/bulk-import validates the body shape and size limits", async () => {
  for (const body of [{}, { items: [] }, { items: "x" }, [], "not json"]) {
    const res = await grokRoute.POST(post("grok-cli/bulk-import", body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const tooMany = await grokRoute.POST(
    post("grok-cli/bulk-import", { items: Array.from({ length: 101 }, () => "x") })
  );
  assert.equal(tooMany.status, 400);

  const huge = await grokRoute.POST(
    post("grok-cli/bulk-import", { items: [{ access_token: "a".repeat(1_100_000) }] })
  );
  assert.equal(huge.status, 413);
});

// --------------------------------------------------------------------------- auth

test("every import route refuses a client API key without the manage scope", async () => {
  await updateSettings({ requireLogin: true, password: "configured-password-hash" });
  const plain = await apiKeysDb.createApiKey("inference-only", "machine1234567890");
  const auth = { authorization: `Bearer ${plain.key}` };
  useGitLab(() => json(200, { username: "x" }));
  const before = {
    gitlab: (await getProviderConnections({ provider: "gitlab-duo" })).length,
    iflow: (await getProviderConnections({ provider: "iflow" })).length,
    grok: (await getProviderConnections({ provider: "grok-cli" })).length,
  };

  const calls: Array<[string, Response]> = [
    [
      "gitlab",
      await gitlabRoute.POST(
        post("gitlab/pat", { token: "glpat-x", baseUrl: "https://gitlab.example.com" }, auth)
      ),
    ],
    ["iflow", await iflowRoute.POST(post("iflow/cookie", { cookie: "BXAuth=abc" }, auth))],
    [
      "grok",
      await grokRoute.POST(post("grok-cli/bulk-import", { items: [fakeJwt({ sub: "z" })] }, auth)),
    ],
  ];
  for (const [label, res] of calls)
    assert.equal(res.status, 403, `${label} answered ${res.status}`);

  const anonymous = await gitlabRoute.POST(post("gitlab/pat", { token: "glpat-x" }));
  assert.equal(anonymous.status, 401);
  const unknownKey = await iflowRoute.POST(
    post("iflow/cookie", { cookie: "BXAuth=abc" }, { authorization: "Bearer sk-not-real" })
  );
  assert.equal(unknownKey.status, 401);

  assert.equal(outbound.length, 0);
  assert.equal((await getProviderConnections({ provider: "gitlab-duo" })).length, before.gitlab);
  assert.equal((await getProviderConnections({ provider: "iflow" })).length, before.iflow);
  assert.equal((await getProviderConnections({ provider: "grok-cli" })).length, before.grok);
});
