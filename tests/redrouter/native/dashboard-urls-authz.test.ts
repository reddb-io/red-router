import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";

// The menu-area URLs (/proxy/providers) are rewritten to the /dashboard pages AFTER the proxy runs,
// so the authz layer sees the new URL. These tests pin that every rule keyed on /dashboard applies
// to the new URLs exactly as to the old ones.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rr-dashboard-urls-authz-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const pipeline = await import("../../../src/server/authz/pipeline.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { isLocalOnlyPath } = await import("../../../src/server/authz/routeGuard.ts");
const { config } = await import("../../../src/proxy.ts");
const urls = await import("../../../src/shared/constants/dashboardUrls.ts");

const require = createRequire(import.meta.url);
const { tryToParsePath } = require("next/dist/lib/try-to-parse-path.js");

const ORIGINAL = {
  JWT_SECRET: process.env.JWT_SECRET,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  REQUIRE_API_KEY: process.env.REQUIRE_API_KEY,
  OMNIROUTE_PEER_STAMP_TOKEN: process.env.OMNIROUTE_PEER_STAMP_TOKEN,
};

function resetEnvironment() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.JWT_SECRET = "dashboard-urls-jwt-secret";
  process.env.INITIAL_PASSWORD = "dashboard-urls-initial-password";
  process.env.REQUIRE_API_KEY = "true";
  delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
}

test.beforeEach(() => {
  resetEnvironment();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
});

async function cookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

async function run(url: string, headers?: Record<string, string>) {
  const response = await pipeline.runAuthzPipeline(new NextRequest(url, { headers }), {
    enforce: true,
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    routeClass: response.headers.get("x-omniroute-route-class"),
    body: response.status === 400 || response.status === 403 ? await response.json() : null,
  };
}

const ORIGIN = "https://example.com";

test("classification runs on the page that is served: the new URL is the old URL's class", () => {
  for (const rule of urls.dashboardUrlRules()) {
    for (const suffix of ["", "/x", "/x/y"]) {
      const shown = classifyRoute(`${rule.newPrefix}${suffix}`, "GET");
      const served = classifyRoute(`${rule.oldPrefix}${suffix}`, "GET");
      assert.equal(shown.normalizedPath, `${rule.oldPrefix}${suffix}`);
      assert.equal(shown.routeClass, "MANAGEMENT", rule.newPrefix);
      assert.deepEqual(
        { ...shown, normalizedPath: "" },
        { ...served, normalizedPath: "" },
        rule.newPrefix
      );
    }
  }
});

test("classification: /home stays a management page, area URLs without a page fall to the default", () => {
  assert.equal(classifyRoute("/home").routeClass, "MANAGEMENT");
  assert.equal(classifyRoute("/home/analytics").normalizedPath, "/dashboard/analytics");
  for (const unmapped of [
    "/proxy",
    "/proxy/unknown",
    "/home/unknown",
    "/system/mitm-proxy",
    "/tools",
    "/proxy%2Fproviders",
    "/proxy/providers%2F..%2Fapi",
  ]) {
    const result = classifyRoute(unmapped);
    assert.equal(result.routeClass, "MANAGEMENT", unmapped);
    assert.equal(result.reason, "fallback_management", unmapped);
  }
});

test("only /dashboard/onboarding is public, and no area URL is an alias of it", () => {
  assert.equal(classifyRoute("/dashboard/onboarding").routeClass, "PUBLIC");
  for (const url of [
    "/proxy/onboarding",
    "/home/onboarding",
    "/system/onboarding",
    "/PROXY/onboarding",
    "/dashboard/onboarding/x",
  ]) {
    assert.equal(classifyRoute(url).routeClass, "MANAGEMENT", url);
  }
  // Nothing in the table can reach it.
  for (const rule of urls.dashboardUrlRules()) {
    assert.notEqual(urls.canonicalDashboardPath(rule.newPrefix), "/dashboard/onboarding");
    assert.equal(
      urls.canonicalDashboardPath(`${rule.newPrefix}/onboarding`).endsWith("/onboarding"),
      true
    );
  }
});

test("the moved pages are ordinary management pages under their new URLs, never public", async () => {
  // Free tiers, Rankings and Radar now sit below /proxy/providers; Quota below /observe/costs.
  const moved = [
    ["/proxy/providers/free-tiers", "/dashboard/free-tiers"],
    ["/proxy/providers/rankings", "/dashboard/free-provider-rankings"],
    ["/proxy/providers/radar", "/dashboard/radar"],
    ["/proxy/providers/radar/setup", "/dashboard/radar/setup"],
    ["/PROXY/Providers/RADAR", "/dashboard/radar"],
    ["/observe/costs/quota", "/dashboard/quota"],
    ["/proxy/keys", "/dashboard/api-manager"],
    ["/proxy/keys/routing", "/dashboard/api-manager/routing"],
    ["/optimize/token-saver", "/dashboard/context/settings"],
    ["/optimize/token-saver/engines/caveman", "/dashboard/context/caveman"],
    ["/optimize/token-saver/studio", "/dashboard/compression/studio"],
    ["/system/settings/storage", "/dashboard/settings/general"],
    ["/system/outbound-proxies", "/dashboard/system/proxy"],
    ["/agents/bridge", "/dashboard/tools/agent-bridge"],
    ["/tools/inspector", "/dashboard/tools/traffic-inspector"],
    ["/proxy/combos/test", "/dashboard/combos/playground"],
  ];
  await settingsDb.updateSettings({ requireLogin: true });
  for (const [shown, page] of moved) {
    const result = classifyRoute(shown, "GET");
    assert.equal(result.normalizedPath, page, shown);
    assert.equal(result.routeClass, "MANAGEMENT", shown);
    assert.deepEqual(await run(`${ORIGIN}${shown}`), await run(`${ORIGIN}${page}`), shown);
    assert.equal((await run(`${ORIGIN}${shown}`)).location, `${ORIGIN}/login`, shown);
  }
  // Nothing in the table, and no tail, turns a rule into the public onboarding page.
  for (const rule of urls.dashboardUrlRules()) {
    assert.equal(classifyRoute(`${rule.newPrefix}/onboarding`).routeClass, "MANAGEMENT");
    assert.equal(classifyRoute(rule.newPrefix).routeClass, "MANAGEMENT");
  }
  // The moved pages do not open the loopback-only proxy either, and a look-alike below one of them is
  // an ordinary (management) 404, not the embedded-service proxy.
  const lookalike = classifyRoute("/proxy/providers/radar/services/x/embed/y", "GET");
  assert.equal(lookalike.normalizedPath, "/dashboard/radar/services/x/embed/y");
  assert.equal(isLocalOnlyPath(lookalike.normalizedPath, "GET"), false);
  assert.equal(lookalike.routeClass, "MANAGEMENT");
  // ...and the real proxy prefix still classifies as the page it always was (Hard Rule #17).
  const embed = classifyRoute("/proxy/providers/services/x/embed/y", "GET");
  assert.equal(embed.normalizedPath, "/dashboard/providers/services/x/embed/y");
  assert.equal(isLocalOnlyPath(embed.normalizedPath, "GET"), true);
  // A walk from a moved page onto the proxy or an API is refused, not interpreted. (The URL parser
  // resolves a real dot segment before Next sees it; the encoded slash is what reaches the proxy.)
  for (const url of [
    "/proxy/providers/radar/../services/x/embed/y",
    "/proxy/providers/free-tiers/%2e%2e/services/x/embed/y",
    "/observe/costs/quota/../../api/settings",
    "/optimize/token-saver/%2E%2E/%2E%2E/api/settings",
  ]) {
    assert.equal(urls.isMalformedAreaUrl(url), true, url);
    assert.equal(urls.canonicalDashboardPath(url), url, url);
  }
  for (const url of [
    "/proxy/providers/radar%2Fservices%2Fx%2Fembed%2Fy",
    "/observe/costs/quota%2F..%2F..%2Fapi%2Fsettings",
    "/optimize/token-saver%2Fengines",
    "/proxy/providers/free-tiers%5C..%5Capi",
  ]) {
    assert.equal(urls.isMalformedAreaUrl(url), true, url);
    assert.equal((await run(`${ORIGIN}${url}`)).status, 400, url);
  }
});

test("the embedded-service proxy is loopback-only under the new URL exactly like the old one (Hard Rules #15/#17)", () => {
  const cases = [
    ["/dashboard/providers/services/9router/embed", "/proxy/providers/services/9router/embed"],
    ["/dashboard/providers/services/x/embed/y", "/proxy/providers/services/x/embed/y"],
    ["/dashboard/providers/services/x/embed/y/z.js", "/PROXY/Providers/services/x/embed/y/z.js"],
    ["/dashboard/providers/services/x/embed/y", "/proxy//providers//services/x/embed/y"],
    ["/dashboard/providers/services/x/embed/y", "/pro%78y/providers/services/x/embed/y"],
  ];
  for (const [oldUrl, newUrl] of cases) {
    const shown = classifyRoute(newUrl, "GET");
    assert.equal(shown.normalizedPath, oldUrl, newUrl);
    assert.equal(isLocalOnlyPath(oldUrl, "GET"), true, oldUrl);
    assert.equal(isLocalOnlyPath(shown.normalizedPath, "GET"), true, newUrl);
    assert.equal(isLocalOnlyPath(shown.normalizedPath, "POST"), true, newUrl);
  }
  // The gate keys on the CANONICAL path: the raw new URL alone is not what it looks at.
  assert.equal(isLocalOnlyPath("/proxy/providers/services/x/embed/y", "GET"), false);
});

test("unauthenticated: every area URL gets the login redirect its /dashboard page gets", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  for (const rule of urls.dashboardUrlRules()) {
    const old = await run(`${ORIGIN}${rule.oldPrefix}`);
    const shown = await run(`${ORIGIN}${rule.newPrefix}`);
    assert.equal(old.status, 307, rule.oldPrefix);
    assert.equal(old.location, `${ORIGIN}/login`);
    assert.deepEqual(shown, old, rule.newPrefix);
    // Deep pages and query strings do not change the answer.
    assert.deepEqual(await run(`${ORIGIN}${rule.newPrefix}/a/b?tab=security`), {
      ...old,
    });
  }
});

test("unauthenticated: case, double slash, trailing slash and encoded letters do not slip through", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  for (const url of [
    "/PROXY/providers",
    "/Proxy/Providers",
    "/proxy//providers",
    "/proxy/providers/",
    "/pro%78y/providers",
    "/HOME/analytics",
    "/OPTIMIZE/context/settings",
    "/proxy",
    "/proxy/unknown",
    "/home",
    "/home/unknown",
    "/tools",
    "/system/mitm-proxy",
  ]) {
    const result = await run(`${ORIGIN}${url}`);
    assert.equal(result.status, 307, url);
    assert.equal(result.location, `${ORIGIN}/login`, url);
    assert.equal(result.routeClass, "MANAGEMENT", url);
  }
  // A path that is not an area URL at all keeps the default answer (management, no page redirect).
  const odd = await run(`${ORIGIN}/proxy%2Fproviders`);
  assert.equal(odd.routeClass, "MANAGEMENT");
  assert.notEqual(odd.status, 200);
});

test("onboarding is public, and the same word under an area is not", async () => {
  delete process.env.INITIAL_PASSWORD;
  await settingsDb.updateSettings({ requireLogin: true, setupComplete: true, password: "" });
  const onboarding = await run(`${ORIGIN}/dashboard/onboarding`);
  assert.equal(onboarding.status, 200);
  assert.equal(onboarding.routeClass, "PUBLIC");
  for (const url of ["/proxy/onboarding", "/home/onboarding", "/PROXY/onboarding"]) {
    const result = await run(`${ORIGIN}${url}`);
    assert.equal(result.routeClass, "MANAGEMENT", url);
    assert.notEqual(result.status, 200, url);
  }
});

test("a signed-in session on a remote host: pages open, the embedded-service proxy stays closed, old and new alike", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  const headers = { cookie: await cookie() };
  const page = await run(`${ORIGIN}/dashboard/providers/services`, headers);
  assert.equal(page.status, 200);
  assert.deepEqual(await run(`${ORIGIN}/proxy/providers/services`, headers), page);
  assert.deepEqual(await run(`${ORIGIN}/PROXY/providers/services`, headers), page);

  for (const embed of [
    "/providers/services/9router/embed",
    "/providers/services/9router/embed/",
    "/providers/services/x/embed/ui/app.js",
  ]) {
    const old = await run(`${ORIGIN}/dashboard${embed}`, headers);
    // Loopback-only is decided before the session: a remote peer is turned away.
    assert.notEqual(old.status, 200, embed);
    for (const shown of [
      `${ORIGIN}/proxy${embed}`,
      `${ORIGIN}/PROXY${embed}`,
      `${ORIGIN}/proxy/${embed.slice(1)}`.replace("/proxy/providers", "/proxy//providers"),
    ]) {
      assert.deepEqual(await run(shown, headers), old, shown);
    }
  }
  // The local operator (real TCP peer 127.0.0.1, stamped by the custom server) is served the same
  // URLs, old and new.
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = "dashboard-urls-peer-stamp-token";
  const stamped = {
    ...headers,
    "x-omniroute-peer-ip": "dashboard-urls-peer-stamp-token|127.0.0.1",
    "x-omniroute-via-proxy": "dashboard-urls-peer-stamp-token|0",
  };
  for (const embed of ["/dashboard", "/proxy", "/PROXY"]) {
    const local = await run(`http://localhost${embed}/providers/services/9router/embed`, stamped);
    assert.equal(local.status, 200, embed);
  }
});

test("a malformed area URL is refused, never interpreted", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  const headers = { cookie: await cookie() };
  for (const url of [
    "/proxy/providers%2F..%2F..%2Fapi%2Fsettings",
    "/proxy/providers/a%2Fb",
    "/proxy/providers/%5C..%5Capi",
    "/proxy/providers/%00",
    "/proxy/providers/%zz",
    "/PROXY/%2Fapi/settings",
    "/home/analytics%2F..%2F..%2Fapi",
  ]) {
    // Even a signed-in session gets no page out of it.
    for (const requestHeaders of [undefined, headers]) {
      const result = await run(`${ORIGIN}${url}`, requestHeaders);
      assert.equal(result.status, 400, url);
      assert.equal(result.body.error.code, "INVALID_PATH", url);
      assert.equal(result.routeClass, "MANAGEMENT", url);
    }
  }
  // The legacy prefix is untouched by the check.
  assert.notEqual((await run(`${ORIGIN}/dashboard/providers/a%2Fb`, headers)).status, 400);
});

test("the redirect to login carries no return address today, so there is no new URL to validate", async () => {
  await settingsDb.updateSettings({ requireLogin: true });
  const response = await run(`${ORIGIN}/proxy/providers?x=1`);
  assert.equal(response.location, `${ORIGIN}/login`);
});

// ─── config.matcher ───────────────────────────────────────────────────────────

function matchedByProxy(pathname: string): boolean {
  return (config.matcher as string[]).some((entry) => {
    const parsed = tryToParsePath(entry);
    // Next builds the matcher from the regexp source only, without path-to-regexp's `i` flag.
    return new RegExp(parsed.regexStr as string).test(pathname);
  });
}

test("proxy.ts matcher covers every area, in any case, so no area URL skips the authz pipeline", () => {
  const areas = urls.dashboardAreaIds();
  assert.equal(areas.length, 8);
  for (const area of areas) {
    const cases = [area, area.toUpperCase(), area[0].toUpperCase() + area.slice(1)];
    for (const name of cases) {
      assert.equal(matchedByProxy(`/${name}`), true, `/${name}`);
      assert.equal(matchedByProxy(`/${name}/x`), true, `/${name}/x`);
      assert.equal(matchedByProxy(`/${name}/x/y/z`), true, `/${name}/x/y/z`);
    }
    // The prefix is a whole segment.
    assert.equal(matchedByProxy(`/${area}s-and-more`), false, `${area} boundary`);
    assert.equal(matchedByProxy(`/${area}x/y`), false, `${area} boundary`);
  }
  for (const rule of urls.dashboardUrlRules()) {
    assert.equal(matchedByProxy(rule.newPrefix), true, rule.newPrefix);
    assert.equal(matchedByProxy(`${rule.newPrefix.toUpperCase()}/A`), true, rule.newPrefix);
  }
  // Nothing else was pulled in: public pages and the health probes still skip the pipeline.
  for (const skipped of [
    "/login",
    "/status",
    "/docs",
    "/healthz",
    "/landing",
    "/connect/codex/x",
    "/_next/static/x.js",
  ]) {
    assert.equal(matchedByProxy(skipped), false, skipped);
  }
  // The pre-existing entries are all still there.
  for (const kept of [
    "/",
    "/dashboard",
    "/dashboard/x",
    "/api/x",
    "/v1/models",
    "/V1/models",
    "/home",
  ]) {
    assert.equal(matchedByProxy(kept), true, kept);
  }
});
