import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Real database on a scratch install. NO network and NO proxy is ever contacted: presets only write
// registry rows.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-proxy-presets-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-proxy-presets";
process.env.STORAGE_ENCRYPTION_KEY = "test-storage-encryption-key-for-proxy-presets";
process.env.API_PORT = "20128";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const proxies = await import("../../../src/lib/db/proxies.ts");
const presetsRoute = await import("../../../src/app/api/settings/proxy-presets/route.ts");
const registryRoute = await import("../../../src/app/api/settings/proxies/route.ts");
const { getAuditLog } = await import("../../../src/lib/compliance/index.ts");

const PASSWORD = "correct horse battery staple 42";
const URL_PATH = "/api/settings/proxy-presets";
const SECRET = "zone-secret-Pa55w0rd-do-not-leak";
const CUSTOMER = "hl_customer9876";

type Json = Record<string, unknown> | null;

async function cookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

async function call(
  handler: (request: Request) => Promise<Response>,
  method: string,
  body?: unknown,
  options: { authenticated?: boolean; raw?: string; url?: string } = {}
) {
  const headers: Record<string, string> = {};
  const hasBody = body !== undefined || options.raw !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  if (options.authenticated !== false) headers.cookie = await cookie();
  const request = new Request(`http://localhost${options.url ?? URL_PATH}`, {
    method,
    headers,
    body:
      options.raw !== undefined
        ? options.raw
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const response = await handler(request);
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : null) as Json };
}

const registryCount = async () => (await proxies.listProxies()).total;

const brightData = (extra: Record<string, unknown> = {}) => ({
  presetId: "brightdata",
  name: "BD residential",
  params: {
    customer: CUSTOMER,
    zone: "res1",
    password: SECRET,
    country: "us",
    stickySession: true,
    ...extra,
  },
});

before(async () => {
  await updateSettings({ requireLogin: true, password: await hashManagementPassword(PASSWORD) });
});

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("auth: GET and POST answer 401 without a management session and create nothing", async () => {
  const before = await registryCount();
  const get = await call(presetsRoute.GET, "GET", undefined, { authenticated: false });
  assert.equal(get.status, 401);
  const post = await call(presetsRoute.POST, "POST", brightData(), { authenticated: false });
  assert.equal(post.status, 401);
  assert.equal(await registryCount(), before);
});

test("GET: the catalog is descriptors only and carries no secret", async () => {
  const res = await call(presetsRoute.GET, "GET");
  assert.equal(res.status, 200);
  const items = (res.json as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(
    items.map((item) => item.id),
    ["tor", "brightdata", "oxylabs", "decodo", "iproyal"]
  );
  for (const item of items) {
    assert.equal("build" in item, false);
    assert.ok(Array.isArray(item.params));
  }
  const bd = items.find((item) => item.id === "brightdata");
  assert.equal(bd?.verified, false);
  assert.match(String(bd?.docsUrl), /^https:\/\//);
  assert.ok(!res.text.includes(SECRET));
});

test("POST: a sticky vendor preset creates a registry proxy and never returns its login", async () => {
  const before = await registryCount();
  const res = await call(presetsRoute.POST, "POST", brightData());
  assert.equal(res.status, 201);
  const body = res.json as {
    proxy: Record<string, unknown>;
    action: string;
    sticky: boolean;
  };
  assert.equal(body.action, "created");
  assert.equal(body.sticky, true);
  assert.equal(body.proxy.host, "brd.superproxy.io");
  assert.equal(body.proxy.port, 33335);
  assert.equal(body.proxy.type, "http");
  assert.equal(body.proxy.name, "BD residential");
  assert.equal(body.proxy.username, "***");
  assert.equal(body.proxy.password, "***");
  assert.ok(!res.text.includes(SECRET), "password not in the create response");
  assert.ok(!res.text.includes(CUSTOMER), "composed username not in the create response");
  assert.equal(await registryCount(), before + 1);

  // Stored through the registry with the composed login (the registry keeps it as-is).
  const id = String(body.proxy.id);
  const stored = await proxies.getProxyById(id, { includeSecrets: true });
  assert.equal(stored?.password, SECRET);
  assert.match(
    stored?.username ?? "",
    new RegExp(`^brd-customer-${CUSTOMER}-zone-res1-country-us-session-[0-9a-f]{12}$`)
  );
  assert.equal(stored?.region, "us");
  assert.equal(stored?.source, "manual");

  // Redacted on every read path.
  const detail = await proxies.getProxyById(id);
  assert.equal(detail?.password, "***");
  assert.equal(detail?.username, "***");
  const list = await call(registryRoute.GET, "GET", undefined, { url: "/api/settings/proxies" });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(SECRET));
  assert.ok(!list.text.includes(CUSTOMER));

  // Audited, without any credential material.
  const entries = getAuditLog({ resourceType: "proxy_registry", limit: 50 });
  const entry = entries.find((e) => e.action === "proxy.preset.apply" && e.target === id);
  assert.ok(entry, "audit entry exists");
  const dump = JSON.stringify(entries);
  assert.ok(dump.includes("brightdata"));
  assert.ok(!dump.includes(SECRET), "password not in audit");
  assert.ok(!dump.includes(CUSTOMER), "customer id / username not in audit");
  assert.ok(!/session-[0-9a-f]{12}/.test(dump), "session id not in audit");
});

test("POST: Tor is accepted on loopback and duplicates update instead of multiplying", async () => {
  const before = await registryCount();
  const first = await call(presetsRoute.POST, "POST", {
    presetId: "tor",
    name: "Tor (local)",
    params: { port: "9050" },
  });
  assert.equal(first.status, 201);
  const proxy = (first.json as { proxy: Record<string, unknown> }).proxy;
  assert.equal(proxy.host, "127.0.0.1");
  assert.equal(proxy.port, 9050);
  assert.equal(proxy.type, "socks5");
  assert.equal(await registryCount(), before + 1);

  // Same host + port + username as an existing row: updated in place, like bulk import.
  const again = await call(presetsRoute.POST, "POST", {
    presetId: "tor",
    name: "Tor renamed",
    params: { port: "9050" },
  });
  assert.equal(again.status, 200);
  assert.equal((again.json as { action: string }).action, "updated");
  assert.equal(await registryCount(), before + 1);
  assert.equal((again.json as { proxy: { name: string } }).proxy.name, "Tor renamed");

  // The Tor Browser port is a different endpoint, so it is a different row.
  const browser = await call(presetsRoute.POST, "POST", {
    presetId: "tor",
    name: "Tor Browser",
    params: { port: "9150" },
  });
  assert.equal(browser.status, 201);
  assert.equal(await registryCount(), before + 2);

  // Omitted params use the descriptor defaults.
  const defaults = await call(presetsRoute.POST, "POST", { presetId: "tor", name: "Tor default" });
  assert.equal(defaults.status, 200);
});

test("POST: rotating presets with the same login collapse, sticky ones stay distinct", async () => {
  const rotating = {
    presetId: "oxylabs",
    name: "Oxy rotating",
    params: { user: "oxyuser", password: "oxy-pw-1", stickySession: false },
  };
  const first = await call(presetsRoute.POST, "POST", rotating);
  assert.equal(first.status, 201);
  const total = await registryCount();
  const second = await call(presetsRoute.POST, "POST", rotating);
  assert.equal(second.status, 200);
  assert.equal(await registryCount(), total);

  const sticky = {
    presetId: "oxylabs",
    name: "Oxy sticky",
    params: { user: "oxyuser", password: "oxy-pw-1", stickySession: true, sessionLength: "10" },
  };
  assert.equal((await call(presetsRoute.POST, "POST", sticky)).status, 201);
  assert.equal((await call(presetsRoute.POST, "POST", sticky)).status, 201);
  assert.equal(await registryCount(), total + 2, "each sticky add gets its own session id");
});

test("POST: invalid requests are rejected with fixed messages and create nothing", async () => {
  const total = await registryCount();
  const good = brightData();
  const cases: Array<[string, number, unknown]> = [
    ["unknown preset", 404, { ...good, presetId: "nope" }],
    ["unknown param", 400, brightData({ shell: "rm -rf" })],
    ["missing customer", 400, brightData({ customer: "" })],
    ["missing password", 400, brightData({ password: "" })],
    ["newline in password", 400, brightData({ password: "a\nb" })],
    ["nul in zone", 400, brightData({ zone: "z\u0000" })],
    ["password too long", 400, brightData({ password: "p".repeat(201) })],
    ["segment separators", 400, brightData({ customer: "a-zone-b" })],
    ["bad country", 400, brightData({ country: "usa" })],
    ["missing name", 400, { ...good, name: "" }],
    ["control char in name", 400, { ...good, name: "a\nb" }],
    ["extra top-level key", 400, { ...good, host: "evil.example" }],
    ["params not an object", 400, { ...good, params: "x" }],
  ];
  for (const [label, status, body] of cases) {
    const res = await call(presetsRoute.POST, "POST", body);
    assert.equal(res.status, status, label);
    assert.ok(!res.text.includes(SECRET), `${label}: no secret echoed`);
    assert.ok(!res.text.includes("rm -rf"), `${label}: no input echoed`);
    assert.ok(!res.text.includes("evil.example"), `${label}: no input echoed`);
  }
  const bad = await call(presetsRoute.POST, "POST", undefined, { raw: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(await registryCount(), total, "nothing was created");
});
