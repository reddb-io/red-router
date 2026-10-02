import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SCAN_ROOTS,
  SKIPPED_FILES,
  applyLiterals,
  findLiterals,
  isSkippedFile,
  scan,
} from "../../../scripts/dev/links-codemod.mjs";
import {
  canonicalDashboardPath,
  dashboardAreaIds,
} from "../../../src/shared/constants/dashboardUrls.ts";

// Ratchet for internal links. The dashboard's URLs follow the menu (`/proxy/providers`, not
// `/dashboard/providers`), so a navigation target written as `/dashboard/<page>` costs the operator a
// redirect and shows the wrong URL. `scripts/dev/links-codemod.mjs` rewrites them; this test fails
// when a new one appears, using the very scanner the codemod uses (`findLiterals`).
//
// The BASELINE is what the codemod cannot or should not change. A literal that is not listed here is
// new; a listed one that is gone must be removed from the list (the ratchet only tightens).

const ROOT_REASON = "the /dashboard root";
const UNOWNED = "page the menu does not own";
const EMBED = "embedded-service proxy (Hard Rule #17)";
const VIA_AREA_URL = "already goes through areaUrl()";
const API = "API route (kept on the old URL by decision; the old-URL redirect serves it)";

const BASELINE: Record<string, number> = {
  // The root `/dashboard` is the app's entry point (login, landing, PWA start URL): it redirects to
  // Home > Usage itself, and is not a menu page.
  [`bin/cli/commands/open.mjs|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/docs/layout.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/error.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/forbidden/page.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/landing/components/Footer.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/landing/components/HeroSection.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/landing/components/Navigation.tsx|/dashboard|${ROOT_REASON}`]: 2,
  [`src/app/landing/page.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/login/page.tsx|/dashboard|${ROOT_REASON}`]: 2,
  [`src/app/manifest.ts|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/not-found.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/page.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/shared/components/Breadcrumbs.tsx|/dashboard|${ROOT_REASON}`]: 1,
  [`src/shared/components/ErrorPageScaffold.tsx|/dashboard|${ROOT_REASON}`]: 1,
  // The first-run wizard is the one public dashboard page and belongs to no menu entry.
  [`src/app/(dashboard)/dashboard/FirstRunReadinessCard.tsx|/dashboard/onboarding|${UNOWNED}`]: 1,
  [`src/app/login/page.tsx|/dashboard/onboarding|${UNOWNED}`]: 3,
  // Hard Rule #17: the embedded-service proxy keeps its /dashboard prefix (authz keys on it).
  [`src/app/(dashboard)/dashboard/providers/services/components/NinerouterEmbedFrame.tsx|/dashboard/providers/services/9router/embed/|${EMBED}`]: 2,
  // Wrapped by areaUrl(): mapped at run time, so it follows the table by construction.
  [`src/shared/components/Sidebar.tsx|/dashboard/analytics|${VIA_AREA_URL}`]: 1,
  // API routes were left alone on purpose: they answer with a redirect to the old URL, which the
  // generated redirect then sends on (one extra hop, same page).
  [`src/app/api/auth/oidc/callback/route.ts|/dashboard/settings/security?oidc_test=|${API}`]: 1,
  [`src/app/api/auth/oidc/callback/route.ts|/dashboard/settings/security?oidc_test=ok|${API}`]: 1,
  [`src/app/api/auth/saml/acs/route.ts|/dashboard/settings/security?saml_test=|${API}`]: 1,
  [`src/app/api/auth/saml/acs/route.ts|/dashboard/settings/security?saml_test=ok|${API}`]: 1,
  [`src/app/api/auth/saml/acs/route.ts|/dashboard|${ROOT_REASON}`]: 1,
  [`src/app/api/search/providers/route.ts|/dashboard/providers|${API}`]: 2,
};

/** Files whose /dashboard literals are out of the ratchet, with the reason (see the codemod). */
const OUT_OF_SCOPE = new Set(SKIPPED_FILES.map(([, why]) => why));

function counts() {
  const found: Record<string, number> = {};
  for (const { file, skipped, literals } of scan()) {
    // API routes are scanned (their literals are listed above); every other skipped file is not.
    if (skipped && skipped !== "API routes") continue;
    for (const literal of literals) {
      if (literal.reason === "comment") continue;
      const label = literal.action === "replace" ? API : literal.reason;
      const key = `${file}|${literal.text}|${label}`;
      found[key] = (found[key] ?? 0) + 1;
    }
  }
  return found;
}

test("no new hard-coded /dashboard/<page> navigation literal (run scripts/dev/links-codemod.mjs --write)", () => {
  const found = counts();
  const added = Object.entries(found).filter(([key, n]) => n > (BASELINE[key] ?? 0));
  assert.deepEqual(
    added.map(([key, n]) => `${key} x${n}`),
    [],
    "a /dashboard/<page> literal was added: use the page's area URL (node scripts/dev/links-codemod.mjs --write)"
  );
  const stale = Object.entries(BASELINE).filter(([key, n]) => (found[key] ?? 0) < n);
  assert.deepEqual(
    stale.map(([key]) => key),
    [],
    "these literals are gone: remove them from the baseline so the ratchet tightens"
  );
});

test("the codemod has nothing left to rewrite outside the API routes", () => {
  for (const { file, skipped, source, literals } of scan()) {
    if (skipped) continue;
    assert.deepEqual(
      literals.filter((literal) => literal.action === "replace").map((literal) => literal.text),
      [],
      file
    );
    assert.equal(applyLiterals(source, literals), source, file);
  }
});

test("the codemod maps what it should and leaves alone what it must", () => {
  const sample = [
    'href="/dashboard/providers"',
    "`/dashboard/providers/${id}?x=1`",
    'redirect("/dashboard/context/caveman")',
    'router.push("/dashboard/settings/general")',
    "`/dashboard/settings/${tab}`", // a page below has its own URL: left for a hand fix
    "`/dashboard/context/${engine}`", // ditto
    'if (path === "/dashboard/providers")',
    'if (path.startsWith("/dashboard/providers/"))',
    'href="/dashboard"',
    'href="/dashboard/onboarding"',
    'src="/dashboard/providers/services/x/embed/y"',
    'href="/dashboard/media-providers/embedding"',
    '// see "/dashboard/providers" in the notes',
    'href={areaUrl("/dashboard/providers")}',
  ].join("\n");
  const found = findLiterals(sample);
  assert.deepEqual(
    found.map((literal) => (literal.action === "replace" ? literal.to : literal.reason)),
    [
      "/proxy/providers",
      "/proxy/providers/",
      "/optimize/token-saver/engines/caveman",
      "/system/settings/storage",
      "dynamic: a page below has its own URL",
      "dynamic: a page below has its own URL",
      "compares a pathname",
      "compares a pathname",
      "the /dashboard root",
      "page the menu does not own",
      "embedded-service proxy (Hard Rule #17)",
      "/proxy/media-providers/embedding",
      "comment",
      "already goes through areaUrl()",
    ]
  );
  assert.equal(
    applyLiterals(
      "`/dashboard/providers/${id}?x=1`",
      findLiterals("`/dashboard/providers/${id}?x=1`")
    ),
    "`/proxy/providers/${id}?x=1`"
  );
});

test("the files the ratchet does not read are the ones that must keep /dashboard prefixes", () => {
  for (const [file, why] of [
    ["src/server/authz/classify.ts", "authz: keyed on the /dashboard prefix"],
    ["src/server/authz/pipeline.ts", "authz: keyed on the /dashboard prefix"],
    ["src/server/authz/routeGuard.ts", "authz: keyed on the /dashboard prefix"],
    ["src/proxy.ts", "proxy matcher: keyed on the /dashboard prefix"],
    ["src/shared/utils/apiAuth.ts", "auth: public-page check on the /dashboard path"],
    [
      "src/shared/constants/dashboardUrls.ts",
      "the URL table and the menu model it is derived from",
    ],
    ["src/shared/constants/sidebarNav.ts", "the URL table and the menu model it is derived from"],
    ["src/lib/services/reverseProxy.ts", "embedded-service proxy (Hard Rule #17)"],
    ["src/lib/services/htmlRewriter.ts", "embedded-service proxy (Hard Rule #17)"],
    ["src/app/api/settings/route.ts", "API routes"],
    ["tests/unit/anything.test.ts", "tests"],
    ["src/shared/components/Sidebar.search.test.tsx", "tests"],
  ]) {
    assert.equal(isSkippedFile(file), why, file);
  }
  // The pages themselves are read: a component is not exempt for living in the dashboard folder.
  for (const file of [
    "src/shared/constants/sidebarVisibility/sections.ts",
    "src/app/(dashboard)/dashboard/providers/page.tsx",
    "src/shared/components/Sidebar.tsx",
    "bin/cli/commands/open.mjs",
  ]) {
    assert.equal(isSkippedFile(file), null, file);
  }
  assert.ok(OUT_OF_SCOPE.size >= 5);
  assert.deepEqual(SCAN_ROOTS, ["src", "bin/cli"]);
});

// ─── area URLs written in source must point at a page ─────────────────────────

/** Files where an `/<area>/...` string is not a dashboard link. */
const NOT_LINKS = [
  /\.test\.[cm]?[jt]sx?$/,
  /^tests?\//,
  /^src\/proxy\.ts$/, // the matcher lists the bare area prefixes
  /^src\/server\/authz\//,
  /^src\/shared\/constants\/(dashboardUrls|dashboardUrlHistory|sidebarNav)\.ts$/,
  /^src\/lib\/(cloudflaredTunnel|api\/publicSafeTunnelError)\.ts$/, // filesystem paths (/system/etc/...)
];

test("every area URL written in source is a URL the table serves (no stale link after a table change)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const areas = dashboardAreaIds().join("|");
  const literal = new RegExp(`(["'\`])(/(?:${areas})(?=/|["'\`?#$\\s])(?:/[^"'\`$\\s]*)?)`, "g");
  // API endpoints sharing a prefix with an area are not navigation links.
  assert.deepEqual(
    [...'"/systemone" "/system/not-a-page"'.matchAll(literal)].map((match) => match[2]),
    ["/system/not-a-page"]
  );
  const root = path.resolve(".");
  const stale: string[] = [];
  let checked = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && !name.startsWith(".")) visit(full);
      } else if (/\.(tsx?|mjs|js)$/.test(name)) {
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (NOT_LINKS.some((pattern) => pattern.test(relative))) continue;
        const source = readFileSync(full, "utf8");
        for (const match of source.matchAll(literal)) {
          const target = match[2].split(/[?#]/)[0].replace(/\/$/, "");
          if (target === "/home" || /^\/(home)\/</.test(target)) continue;
          checked += 1;
          if (canonicalDashboardPath(target) === target) stale.push(`${relative}: ${match[2]}`);
        }
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) visit(path.join(root, scanRoot));
  assert.ok(checked > 100, `only ${checked} area URLs found; is the scan reading the source?`);
  assert.deepEqual(stale, []);
});
