import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as urls from "../../../src/shared/constants/dashboardUrls.ts";

const require = createRequire(import.meta.url);
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js");
const { prepareDestination } = require("next/dist/shared/lib/router/utils/prepare-destination.js");
const { checkCustomRoutes } = require("next/dist/lib/load-custom-routes.js");

interface Route {
  source: string;
  destination: string;
  permanent?: boolean;
}

const config = (
  await import(`${pathToFileURL(path.join(process.cwd(), "next.config.mjs")).href}?dashboard-urls`)
).default;
const rewrites = (await config.rewrites()) as {
  beforeFiles: Route[];
  afterFiles: Route[];
  fallback: Route[];
};
const redirects = (await config.redirects()) as Route[];
const headers = (await config.headers()) as { source: string; headers: unknown[] }[];

const match = (source: string, pathname: string) =>
  getPathMatch(source, { removeUnnamedParams: true })(pathname);
const hits = (routes: Route[], pathname: string) =>
  routes.filter((route) => match(route.source, pathname) !== false);

/** What Next does with a matched redirect: the destination path and the query it keeps. */
function redirectTarget(route: Route, pathname: string, query: Record<string, string> = {}) {
  const params = match(route.source, pathname);
  const { parsedDestination } = prepareDestination({
    appendParamsToQuery: false,
    destination: route.destination,
    params,
    query,
  });
  return { pathname: parsedDestination.pathname as string, query: parsedDestination.query };
}

const generatedRedirects = urls.dashboardUrlRedirects();

test("Next accepts the generated routes", () => {
  checkCustomRoutes(rewrites.beforeFiles, "rewrite");
  checkCustomRoutes(rewrites.afterFiles, "rewrite");
  checkCustomRoutes(redirects, "redirect");
  checkCustomRoutes(headers, "header");
});

test("the client-API aliases are still afterFiles, and the area rewrites come first", () => {
  assert.ok(rewrites.afterFiles.some((route) => route.source === "/v1/:path*"));
  assert.ok(rewrites.afterFiles.some((route) => route.source === "/models"));
  assert.equal(
    rewrites.afterFiles.some((route) => route.destination.startsWith("/dashboard")),
    false
  );
  assert.deepEqual(rewrites.beforeFiles, urls.dashboardUrlRewrites());
  assert.deepEqual(rewrites.fallback, []);
});

test("every rewrite has the redirect that undoes it, and the reverse", () => {
  assert.equal(rewrites.beforeFiles.length, urls.dashboardUrlRules().length);
  for (const rewrite of rewrites.beforeFiles) {
    const newPrefix = rewrite.source.replace(/\/:path\*$/, "");
    const oldPrefix = rewrite.destination.replace(/\/:path\*$/, "");
    const pair = generatedRedirects.filter(
      (redirect) =>
        redirect.source === oldPrefix || redirect.source.startsWith(`${oldPrefix}/:path`)
    );
    assert.ok(pair.length > 0, `${newPrefix} has no redirect from ${oldPrefix}`);
    for (const redirect of pair) {
      assert.equal(redirect.destination.startsWith(newPrefix), true, redirect.destination);
      assert.equal(redirect.permanent, false, "temporary while the scheme settles");
    }
    // Round trip through Next's own matcher: old page URL -> area URL -> (rewrite) -> same page.
    for (const tail of ["", "/detail", "/a/b"]) {
      const oldUrl = `${oldPrefix}${tail}`;
      const [redirect] = hits(generatedRedirects, oldUrl);
      assert.ok(redirect, `${oldUrl} is not redirected`);
      const shown = redirectTarget(redirect, oldUrl).pathname;
      assert.equal(shown, `${newPrefix}${tail}`);
      const [served] = hits(rewrites.beforeFiles, shown);
      assert.ok(served, `${shown} is not rewritten`);
      const target = redirectTarget(served, shown).pathname;
      assert.equal(target, oldUrl);
    }
  }
});

test("no loop: a rewritten page is never redirected again, and a redirected URL is never redirected onward", () => {
  for (const rewrite of rewrites.beforeFiles) {
    const sample = rewrite.source.replace(/\/:path\*$/, "/x");
    const served = redirectTarget(rewrite, sample).pathname;
    assert.equal(hits(generatedRedirects, sample).length, 0, `${sample} is a redirect source`);
    assert.equal(hits(rewrites.beforeFiles, served).length, 0, `${served} is rewritten again`);
    assert.equal(hits(rewrites.afterFiles, served).length, 0, `${served} hits an alias`);
  }
  for (const redirect of generatedRedirects) {
    const sample = redirect.source.startsWith("/dashboard/providers/:path")
      ? "/dashboard/providers/x"
      : redirect.source.replace(/\/:path\*$/, "/x");
    const target = redirectTarget(redirect, sample).pathname;
    assert.equal(hits(generatedRedirects, target).length, 0, `${target} is redirected again`);
    assert.equal(hits(redirects, target).length, 0, `${target} matches a redirect`);
  }
});

test("the older specific redirects still win and now chain into the new URLs", () => {
  const index = (source: string) => redirects.findIndex((route) => route.source === source);
  const firstGenerated = redirects.length - generatedRedirects.length;
  for (const source of [
    "/dashboard/omni-skills",
    "/dashboard/providers/freepik",
    "/dashboard/cli-tools/:path*",
    "/dashboard/agents/:path*",
    "/docs/architecture",
  ]) {
    assert.ok(index(source) >= 0 && index(source) < firstGenerated, source);
  }
  assert.deepEqual(redirects.slice(-generatedRedirects.length), generatedRedirects);
  // freepik keeps its own answer; the destination it names is then moved by the generic rule.
  assert.equal(
    hits(redirects, "/dashboard/providers/freepik")[0].destination,
    "/dashboard/providers/magnific"
  );
  assert.equal(
    redirectTarget(
      hits(generatedRedirects, "/dashboard/providers/magnific")[0],
      "/dashboard/providers/magnific"
    ).pathname,
    "/proxy/providers/magnific"
  );
  // Removed pages still go home.
  assert.equal(hits(redirects, "/dashboard/changelog")[0].destination, "/home");
});

test("the query string survives the redirect, and an empty tail leaves no trailing slash", () => {
  const settings = hits(generatedRedirects, "/dashboard/settings")[0];
  const target = redirectTarget(settings, "/dashboard/settings", { tab: "security" });
  assert.equal(target.pathname, "/system/settings");
  assert.deepEqual(target.query, { tab: "security" });
  const deep = hits(generatedRedirects, "/dashboard/providers/services/9router")[0];
  assert.equal(
    redirectTarget(deep, "/dashboard/providers/services/9router").pathname,
    "/proxy/providers/services/9router"
  );
});

test("the embedded-service proxy subtree is never redirected, and stays framable by the dashboard", () => {
  for (const embed of [
    "/dashboard/providers/services/9router/embed",
    "/dashboard/providers/services/9router/embed/",
    "/dashboard/providers/services/9router/embed/ui/app.js",
    "/dashboard/providers/services/x/embed/a/b/c",
  ]) {
    assert.equal(hits(redirects, embed).length, 0, embed);
    // ...but it is reachable, and gated, under the area URL too (see the authz tests).
    const shown = embed.replace("/dashboard/", "/proxy/");
    assert.equal(hits(rewrites.beforeFiles, shown).length, 1, shown);
  }
  // Look-alikes are not the proxy: they are ordinary pages and are redirected.
  for (const page of [
    "/dashboard/providers/services/9router/embeddings",
    "/dashboard/providers/services/9router",
    "/dashboard/providers/services",
    "/dashboard/providers/embed",
  ]) {
    assert.equal(hits(generatedRedirects, page).length, 1, page);
  }
  const rules = urls.dashboardUrlRules();
  for (const exclusion of urls.DASHBOARD_REDIRECT_EXCLUSIONS) {
    const excluded = `/dashboard/${exclusion.join("/")}`.replace("*", "x");
    assert.equal(
      rules.some((rule) => rule.oldPrefix.startsWith("/dashboard/providers/services/")),
      false,
      `${excluded} must be covered by its parent rule, not by a rule of its own`
    );
  }
  const embedHeaders = headers.filter((rule) => rule.source.includes("/embed/"));
  assert.deepEqual(embedHeaders.map((rule) => rule.source).sort(), [
    "/dashboard/providers/services/:name/embed/:path*",
    "/proxy/providers/services/:name/embed/:path*",
  ]);
  for (const rule of embedHeaders) {
    assert.deepEqual(rule.headers, [
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
    ]);
  }
  assert.ok(
    match(
      "/proxy/providers/services/:name/embed/:path*",
      "/proxy/providers/services/9router/embed/x"
    )
  );
});

// ─── collisions ───────────────────────────────────────────────────────────────

/** Top-level URL segments the app serves as real routes (route groups do not count). */
function topLevelRoutes(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (name.startsWith("(")) {
      for (const [segment, where] of topLevelRoutes(full)) found.set(segment, where);
    } else if (!name.startsWith("_") && !name.startsWith("@")) {
      found.set(name, full);
    }
  }
  return found;
}

test("no area collides with a real top-level route, and /home keeps serving its own page", () => {
  const appRoot = path.resolve("src/app");
  const real = topLevelRoutes(appRoot);
  const publicNames = new Set(readdirSync(path.resolve("public")));
  for (const rewrite of rewrites.beforeFiles) {
    const [, area, ...rest] = rewrite.source.split("/");
    assert.ok(rest.length > 0);
    assert.equal(publicNames.has(area), false, `public/${area}`);
    if (area === "home") continue;
    assert.equal(real.has(area), false, `/${area} is a real route: ${real.get(area)}`);
  }
  // `home` is a real route, so the rewrites may only sit strictly below it and not on a folder it has.
  const homeDir = real.get("home");
  assert.ok(homeDir);
  assert.ok(existsSync(path.join(homeDir, "page.tsx")), "/home is the topology page");
  const homeFolders = readdirSync(homeDir).filter((name) =>
    statSync(path.join(homeDir, name)).isDirectory()
  );
  for (const rewrite of rewrites.beforeFiles) {
    if (!rewrite.source.startsWith("/home/")) continue;
    const segment = rewrite.source.split("/")[2];
    assert.equal(homeFolders.includes(segment), false, `/home/${segment} shadows a folder`);
  }
  assert.equal(hits(rewrites.beforeFiles, "/home").length, 0, "/home itself is not rewritten");
  assert.equal(hits(redirects, "/home").length, 0);
  // Every destination is an existing dashboard route folder or a folder tree that has pages.
  const dashboardRoot = path.resolve("src/app/(dashboard)");
  for (const rewrite of rewrites.beforeFiles) {
    const folder = path.join(dashboardRoot, rewrite.destination.replace(/\/:path\*$/, ""));
    assert.ok(existsSync(folder), `${rewrite.destination} has no folder ${folder}`);
  }
  // The area names are not taken by a client-API alias either.
  for (const alias of rewrites.afterFiles) {
    const first = alias.source.split("/")[1];
    assert.equal(urls.dashboardAreaIds().includes(first), false, alias.source);
  }
});
