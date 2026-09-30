import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DASHBOARD_URL_OVERRIDES,
  areaUrl,
  canonicalDashboardPath,
  dashboardAreaIds,
  dashboardUrlRules,
  deriveDashboardUrlRules,
  isAreaUrl,
  isMalformedAreaUrl,
} from "../../../src/shared/constants/dashboardUrls.ts";
import {
  SIDEBAR_NAV_SECTIONS,
  allNavTabs,
  findNavMatch,
  resolveNavSections,
} from "../../../src/shared/constants/sidebarNav.ts";

const none = new Set<string>();

/** Every internal page the menu can reach, tab hrefs and detail pages alike. */
const navHrefs = allNavTabs()
  .map((tab) => tab.href)
  .filter((href) => href.startsWith("/dashboard/"));

test("the menu areas are the areas of the table", () => {
  assert.deepEqual(dashboardAreaIds(), [
    "home",
    "proxy",
    "optimize",
    "agents",
    "observe",
    "tools",
    "system",
  ]);
  assert.deepEqual(
    dashboardAreaIds(),
    SIDEBAR_NAV_SECTIONS.map((section) => section.id)
  );
});

test("the friendly names the operator asked for fall out of the rule", () => {
  assert.equal(areaUrl("/dashboard/providers"), "/proxy/providers");
  assert.equal(areaUrl("/dashboard/models"), "/proxy/models");
  assert.equal(areaUrl("/dashboard/combos"), "/proxy/combos");
  assert.equal(areaUrl("/dashboard/endpoint"), "/proxy/endpoint");
  assert.equal(areaUrl("/dashboard/providers/openai"), "/proxy/providers/openai");
  assert.equal(areaUrl("/dashboard/providers/services"), "/proxy/providers/services");
});

test("the URL of a page is its label, wherever the folder is called something else", () => {
  for (const [page, shown] of [
    ["/dashboard/api-manager", "/proxy/keys"],
    ["/dashboard/api-manager/routing", "/proxy/keys/routing"],
    ["/dashboard/combos/playground", "/proxy/combos/test"],
    ["/dashboard/free-tiers", "/proxy/providers/free-tiers"],
    ["/dashboard/free-provider-rankings", "/proxy/providers/rankings"],
    ["/dashboard/radar", "/proxy/providers/radar"],
    ["/dashboard/radar/intel", "/proxy/providers/radar/intel"],
    ["/dashboard/quota", "/observe/costs/quota"],
    ["/dashboard/costs/quota-share", "/observe/costs/quota-share"],
    ["/dashboard/runtime", "/observe/health/runtime"],
    ["/dashboard/resilience/connections", "/observe/health/connections"],
    ["/dashboard/conversations", "/observe/logs/conversations"],
    ["/dashboard/activity", "/observe/logs/activity"],
    ["/dashboard/tools/agent-bridge", "/agents/bridge"],
    ["/dashboard/tools/traffic-inspector", "/tools/inspector"],
    ["/dashboard/settings/general", "/system/settings/storage"],
    ["/dashboard/settings/appearance", "/system/settings/appearance"],
    ["/dashboard/system/proxy", "/system/outbound-proxies"],
    // Token saver: three folders (context, compression, analytics) under one namespace.
    ["/dashboard/context/settings", "/optimize/token-saver"],
    ["/dashboard/context/engines", "/optimize/token-saver/engines"],
    ["/dashboard/context/caveman", "/optimize/token-saver/engines/caveman"],
    ["/dashboard/context/combos", "/optimize/token-saver/combos"],
    ["/dashboard/compression/studio", "/optimize/token-saver/studio"],
    ["/dashboard/compression/exclusions", "/optimize/token-saver/exclusions"],
    ["/dashboard/compression/live", "/optimize/token-saver/live"],
    ["/dashboard/analytics/compression", "/optimize/token-saver/analytics"],
    // Whatever else is in those folders stays reachable under its old segment.
    ["/dashboard/context", "/optimize/token-saver/context"],
    ["/dashboard/context/unlisted", "/optimize/token-saver/context/unlisted"],
    ["/dashboard/compression", "/optimize/token-saver/compression"],
    ["/dashboard/compression/unlisted", "/optimize/token-saver/compression/unlisted"],
  ] as const) {
    assert.equal(areaUrl(page), shown, page);
    assert.equal(canonicalDashboardPath(shown), page, shown);
  }
});

test("the overrides are a bijection: unique on both sides, well formed, none redundant", () => {
  const shown = DASHBOARD_URL_OVERRIDES.map(([next]) => next);
  const pages = DASHBOARD_URL_OVERRIDES.map(([, page]) => page);
  assert.equal(new Set(shown).size, shown.length, "area URLs");
  assert.equal(new Set(pages).size, pages.length, "pages");
  const areas = new Set(dashboardAreaIds());
  for (const [next, page] of DASHBOARD_URL_OVERRIDES) {
    assert.ok(areas.has(next.split("/")[1]), next);
    assert.ok(page.startsWith("/dashboard/"), page);
    assert.doesNotMatch(next + page, /[A-Z:*?()\s]|\/\/|\/$/);
    // An override is in the table as written, and is what the page maps to.
    assert.ok(
      dashboardUrlRules().some((r) => r.newPrefix === next && r.oldPrefix === page),
      next
    );
    assert.equal(areaUrl(page), next);
    assert.equal(canonicalDashboardPath(next), page);
  }
  // No override is implied by a rule that is already there (a redundant row would only hide a typo).
  const withoutOverrides = deriveDashboardUrlRules(SIDEBAR_NAV_SECTIONS, []);
  for (const [next, page] of DASHBOARD_URL_OVERRIDES) {
    const derived = withoutOverrides.find(
      (r) => page === r.oldPrefix || page.startsWith(`${r.oldPrefix}/`)
    );
    assert.notEqual(
      derived && `${derived.newPrefix}${page.slice(derived.oldPrefix.length)}`,
      next,
      `${next} is what the folder already gives`
    );
  }
});

test("every engine page is under Engines, and every Token saver page is under the namespace", () => {
  const saver = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find((e) => e.id === "token-saver");
  assert.ok(saver);
  for (const tab of saver.tabs) {
    const shown = areaUrl(tab.href);
    assert.match(shown, /^\/optimize\/token-saver(\/|$)/, `${tab.label}: ${shown}`);
    for (const child of tab.children ?? []) {
      const engine = child.href.split("/").pop();
      assert.equal(areaUrl(child.href), `/optimize/token-saver/engines/${engine}`, child.href);
    }
  }
  // Every folder that has a page under context/ and compression/ has an area URL below the namespace.
  for (const folder of ["context", "compression"]) {
    const root = path.resolve(`src/app/(dashboard)/dashboard/${folder}`);
    for (const name of readdirSync(root)) {
      if (!statSync(path.join(root, name)).isDirectory()) continue;
      if (!existsSync(path.join(root, name, "page.tsx"))) continue;
      assert.match(
        areaUrl(`/dashboard/${folder}/${name}`),
        /^\/optimize\/token-saver(\/|$)/,
        `${folder}/${name}`
      );
    }
  }
});

test("Providers owns Free tiers, Rankings and Radar; the provider ids never collide with them", async () => {
  // Every id the catalogue and the registry know (built-in providers; custom ones are `<kind>-<uuid>`).
  const constants: Record<string, unknown> =
    await import("../../../src/shared/constants/providers.ts");
  const registry: { REGISTRY?: Record<string, unknown> } =
    await import("../../../open-sse/config/providerRegistry.ts");
  const ids = new Set<string>(Object.keys(registry.REGISTRY ?? {}));
  for (const [name, value] of Object.entries(constants)) {
    if (!/PROVIDERS$/.test(name) || !value || typeof value !== "object") continue;
    for (const [id, definition] of Object.entries(value as Record<string, { id?: string }>)) {
      ids.add(id);
      if (definition?.id) ids.add(definition.id);
    }
  }
  assert.ok(ids.size > 100, "the registry was read");
  // `/proxy/providers/<id>` is the provider detail page; these segments are pages, and win by length.
  const reserved = ["free-tiers", "rankings", "radar", "services", "new"];
  for (const segment of reserved) {
    assert.equal(ids.has(segment), false, `a provider is called ${segment}`);
  }
  // The three moved pages are rewritten to their own folders, not to a provider detail page;
  // `services` and `new` are static folders under providers/ that already beat `[id]`.
  for (const segment of ["free-tiers", "rankings", "radar"]) {
    const served = canonicalDashboardPath(`/proxy/providers/${segment}`);
    assert.notEqual(served, `/dashboard/providers/${segment}`, segment);
  }
  for (const segment of ["services", "new"]) {
    assert.ok(
      existsSync(path.resolve(`src/app/(dashboard)/dashboard/providers/${segment}`)),
      segment
    );
  }
  assert.equal(canonicalDashboardPath("/proxy/providers/free-tiers"), "/dashboard/free-tiers");
  assert.equal(
    canonicalDashboardPath("/proxy/providers/services"),
    "/dashboard/providers/services"
  );
  assert.equal(canonicalDashboardPath("/proxy/providers/openai"), "/dashboard/providers/openai");
  // Custom providers are created as `<kind>-<uuid>`, so they cannot be those words either.
  for (const id of ids) assert.equal(reserved.includes(id), false, id);
});

test("rules: unique, well formed, and every page of the menu is covered", () => {
  const rules = dashboardUrlRules();
  assert.equal(new Set(rules.map((rule) => rule.newPrefix)).size, rules.length, "new URLs");
  assert.equal(new Set(rules.map((rule) => rule.oldPrefix)).size, rules.length, "old URLs");
  const areas = new Set(dashboardAreaIds());
  for (const rule of rules) {
    assert.ok(rule.oldPrefix.startsWith("/dashboard/"), rule.oldPrefix);
    assert.ok(areas.has(rule.area), rule.area);
    assert.ok(rule.newPrefix.startsWith(`/${rule.area}/`), rule.newPrefix);
    assert.doesNotMatch(rule.newPrefix + rule.oldPrefix, /[A-Z:*?()\s]/);
  }
  for (const href of navHrefs) {
    assert.notEqual(areaUrl(href), href, `${href} has no area URL`);
  }
  // Ordered longest first, so the most specific rule wins in a rewrite/redirect list.
  const depth = (value: string) => value.split("/").length;
  for (let index = 1; index < rules.length; index += 1) {
    assert.ok(depth(rules[index - 1].oldPrefix) >= depth(rules[index].oldPrefix));
  }
});

test("round trip: every page of the menu, and every rule, maps there and back unchanged", () => {
  for (const href of navHrefs) {
    assert.equal(canonicalDashboardPath(areaUrl(href)), href, href);
    // Anything below a page follows it, and a query string or hash rides along.
    assert.equal(canonicalDashboardPath(areaUrl(`${href}/detail`)), `${href}/detail`, href);
    const shown = areaUrl(`${href}?tab=security#top`);
    assert.ok(shown.endsWith("?tab=security#top"), shown);
    assert.equal(canonicalDashboardPath(shown.split(/[?#]/)[0]), href, href);
  }
  for (const rule of dashboardUrlRules()) {
    assert.equal(canonicalDashboardPath(rule.newPrefix), rule.oldPrefix);
    assert.equal(areaUrl(rule.oldPrefix), rule.newPrefix);
    assert.equal(areaUrl(canonicalDashboardPath(rule.newPrefix)), rule.newPrefix);
  }
});

test("the full table (what the operator sees for each existing page)", () => {
  const table = Object.fromEntries(
    dashboardUrlRules().map((rule) => [rule.oldPrefix, rule.newPrefix])
  );
  assert.deepEqual(table, {
    "/dashboard/a2a": "/proxy/a2a",
    "/dashboard/acp-agents": "/agents/acp-agents",
    "/dashboard/activity": "/observe/logs/activity",
    "/dashboard/agent-skills": "/optimize/agent-skills",
    "/dashboard/analytics": "/home/analytics",
    "/dashboard/analytics/compression": "/optimize/token-saver/analytics",
    "/dashboard/api-endpoints": "/observe/api-endpoints",
    "/dashboard/api-manager": "/proxy/keys",
    "/dashboard/audit": "/observe/audit",
    "/dashboard/batch": "/system/batch",
    "/dashboard/cache": "/optimize/cache",
    "/dashboard/chaos": "/system/chaos",
    "/dashboard/cli-agents": "/agents/cli-agents",
    "/dashboard/cli-code": "/agents/cli-code",
    "/dashboard/cloud-agents": "/agents/cloud-agents",
    "/dashboard/combos": "/proxy/combos",
    "/dashboard/combos/playground": "/proxy/combos/test",
    "/dashboard/compression": "/optimize/token-saver/compression",
    "/dashboard/compression/exclusions": "/optimize/token-saver/exclusions",
    "/dashboard/compression/live": "/optimize/token-saver/live",
    "/dashboard/compression/studio": "/optimize/token-saver/studio",
    "/dashboard/conductor": "/agents/conductor",
    "/dashboard/context": "/optimize/token-saver/context",
    "/dashboard/context/aggressive": "/optimize/token-saver/engines/aggressive",
    "/dashboard/context/caveman": "/optimize/token-saver/engines/caveman",
    "/dashboard/context/ccr": "/optimize/token-saver/engines/ccr",
    "/dashboard/context/combos": "/optimize/token-saver/combos",
    "/dashboard/context/engines": "/optimize/token-saver/engines",
    "/dashboard/context/headroom": "/optimize/token-saver/engines/headroom",
    "/dashboard/context/lite": "/optimize/token-saver/engines/lite",
    "/dashboard/context/llmlingua": "/optimize/token-saver/engines/llmlingua",
    "/dashboard/context/omniglyph": "/optimize/token-saver/engines/omniglyph",
    "/dashboard/context/rtk": "/optimize/token-saver/engines/rtk",
    "/dashboard/context/session-dedup": "/optimize/token-saver/engines/session-dedup",
    "/dashboard/context/settings": "/optimize/token-saver",
    "/dashboard/context/ultra": "/optimize/token-saver/engines/ultra",
    "/dashboard/conversations": "/observe/logs/conversations",
    "/dashboard/costs": "/observe/costs",
    "/dashboard/discovery": "/tools/discovery",
    "/dashboard/endpoint": "/proxy/endpoint",
    "/dashboard/free-provider-rankings": "/proxy/providers/rankings",
    "/dashboard/free-tiers": "/proxy/providers/free-tiers",
    "/dashboard/health": "/observe/health",
    "/dashboard/log-export": "/observe/log-export",
    "/dashboard/logs": "/observe/logs",
    "/dashboard/mcp": "/proxy/mcp",
    "/dashboard/media-providers": "/proxy/media-providers",
    "/dashboard/memory": "/optimize/memory",
    "/dashboard/models": "/proxy/models",
    "/dashboard/orchestration": "/agents/orchestration",
    "/dashboard/playground": "/tools/playground",
    "/dashboard/plugins": "/agents/plugins",
    "/dashboard/provider-stats": "/home/provider-stats",
    "/dashboard/providers": "/proxy/providers",
    "/dashboard/quota": "/observe/costs/quota",
    "/dashboard/radar": "/proxy/providers/radar",
    "/dashboard/relay": "/proxy/relay",
    "/dashboard/resilience": "/observe/resilience",
    "/dashboard/resilience/connections": "/observe/health/connections",
    "/dashboard/runtime": "/observe/health/runtime",
    "/dashboard/search-tools": "/tools/search-tools",
    "/dashboard/settings": "/system/settings",
    "/dashboard/settings/general": "/system/settings/storage",
    "/dashboard/setup": "/home/setup",
    "/dashboard/skills": "/optimize/skills",
    "/dashboard/system/proxy": "/system/outbound-proxies",
    "/dashboard/tools/agent-bridge": "/agents/bridge",
    "/dashboard/tools/traffic-inspector": "/tools/inspector",
    "/dashboard/translator": "/tools/translator",
    "/dashboard/usage-sinks": "/observe/usage-sinks",
    "/dashboard/webhooks": "/observe/webhooks",
  });
});

test("a longer rule beats its folder: analytics is Home except the compression page", () => {
  assert.equal(areaUrl("/dashboard/analytics"), "/home/analytics");
  assert.equal(areaUrl("/dashboard/analytics/utilization"), "/home/analytics/utilization");
  assert.equal(areaUrl("/dashboard/analytics/compression"), "/optimize/token-saver/analytics");
  assert.equal(
    canonicalDashboardPath("/optimize/token-saver/analytics"),
    "/dashboard/analytics/compression"
  );
  assert.equal(
    canonicalDashboardPath("/home/analytics/combo-health"),
    "/dashboard/analytics/combo-health"
  );
});

test("pages no menu entry owns keep their /dashboard URL, and /home stays /home", () => {
  for (const href of [
    "/dashboard",
    "/dashboard/onboarding",
    "/dashboard/usage",
    "/dashboard/limits",
    "/dashboard/auto-combo",
    "/dashboard/system/mitm-proxy",
    "/dashboard/system/1proxy",
    "/dashboard/tools",
    "/docs",
    "/home",
    "/login",
    "https://github.com/reddb-io/red-router/issues",
  ]) {
    assert.equal(areaUrl(href), href, href);
    assert.equal(canonicalDashboardPath(href), href, href);
  }
  // The real /home route (the topology page) is not an alias of anything.
  assert.equal(canonicalDashboardPath("/home"), "/home");
  assert.equal(canonicalDashboardPath("/home/"), "/home");
  assert.equal(canonicalDashboardPath("/HOME"), "/home");
});

test("the table follows the menu: a page added to it is covered without touching the URL module", () => {
  const rules = deriveDashboardUrlRules([
    ...SIDEBAR_NAV_SECTIONS,
    {
      id: "observe",
      title: "Observe",
      icon: "Activity",
      entries: [
        {
          id: "fresh",
          label: "Fresh",
          icon: "Zap",
          tabs: [{ id: undefined, href: "/dashboard/fresh", label: "Fresh" }],
        },
      ],
    } as never,
  ]);
  assert.ok(
    rules.some(
      (rule) => rule.oldPrefix === "/dashboard/fresh" && rule.newPrefix === "/observe/fresh"
    )
  );
});

test("the attack table: every trick either serves the page that its rewrite serves or is not mapped", () => {
  // Same page as the rewrite: case-insensitive, `//` collapsed, trailing slash, percent-encoded letters.
  const same: Record<string, string> = {
    "/proxy/providers": "/dashboard/providers",
    "/PROXY/providers": "/dashboard/providers",
    "/Proxy/Providers": "/dashboard/providers",
    "/proxy//providers": "/dashboard/providers",
    "//proxy//providers//": "/dashboard/providers",
    "/proxy/providers/": "/dashboard/providers",
    "/pro%78y/providers": "/dashboard/providers",
    "/proxy/provi%64ers": "/dashboard/providers",
    "/PROXY/providers/OpenAI": "/dashboard/providers/OpenAI",
    "/proxy/providers/services/9router/embed/ui/index.html":
      "/dashboard/providers/services/9router/embed/ui/index.html",
    "/PROXY/providers/services/x/embed": "/dashboard/providers/services/x/embed",
    "/system/settings/storage": "/dashboard/settings/general",
    "/SYSTEM/Settings/Storage": "/dashboard/settings/general",
    "/tools/inspector": "/dashboard/tools/traffic-inspector",
    "/agents/bridge": "/dashboard/tools/agent-bridge",
    "/home/analytics": "/dashboard/analytics",
    // The new overrides: the longest prefix wins, case, `//` and encoded letters do not change it.
    "/proxy/providers/radar": "/dashboard/radar",
    "/PROXY/Providers/Radar/intel": "/dashboard/radar/intel",
    "/proxy//providers//free-tiers": "/dashboard/free-tiers",
    "/proxy/providers/free-%74iers": "/dashboard/free-tiers",
    "/proxy/providers/rankings": "/dashboard/free-provider-rankings",
    "/proxy/providers/rankings/": "/dashboard/free-provider-rankings",
    "/proxy/providers/openai": "/dashboard/providers/openai",
    "/proxy/providers/services/x/embed/y": "/dashboard/providers/services/x/embed/y",
    "/proxy/keys": "/dashboard/api-manager",
    "/proxy/keys/routing": "/dashboard/api-manager/routing",
    "/proxy/combos/test": "/dashboard/combos/playground",
    "/optimize/token-saver": "/dashboard/context/settings",
    "/OPTIMIZE/Token-Saver/ENGINES/caveman": "/dashboard/context/caveman",
    "/optimize/token-saver/engines": "/dashboard/context/engines",
    "/optimize/token-saver/studio/a/b": "/dashboard/compression/studio/a/b",
    "/optimize/token-saver/analytics": "/dashboard/analytics/compression",
    "/observe/costs/quota": "/dashboard/quota",
    "/observe/costs/quota-share": "/dashboard/costs/quota-share",
    "/observe/health/runtime": "/dashboard/runtime",
    "/observe/health/connections": "/dashboard/resilience/connections",
    "/observe/logs/conversations": "/dashboard/conversations",
    "/observe/logs/activity": "/dashboard/activity",
    "/system/outbound-proxies": "/dashboard/system/proxy",
  };
  for (const [input, expected] of Object.entries(same)) {
    assert.equal(canonicalDashboardPath(input), expected, input);
    assert.equal(isMalformedAreaUrl(input), false, input);
    assert.ok(canonicalDashboardPath(input).startsWith("/dashboard/"), input);
  }

  // Not a plain path: never interpreted, the proxy answers 400. canonicalDashboardPath leaves it as
  // it came, so a caller that skips the check still lands in the classifier's management default.
  const malformed = [
    "/proxy/%2e%2e/api/settings",
    "/proxy/%2E%2E/api/settings",
    "/proxy/providers/../../api/settings",
    "/proxy/providers/./x",
    "/proxy/providers/%2e%2e%2f%2e%2e%2fapi/settings",
    "/proxy/providers%2F..%2Fapi",
    "/proxy/providers/a%2Fb",
    "/proxy/providers\\..\\api",
    "/proxy/providers/%5c..%5capi",
    "/proxy/providers/%00",
    "/proxy/providers/%zz",
    "/proxy/%2e%2e/connect/codex/x",
    "/system/../api/v1/models",
    "/HOME/%2e%2e/api/settings",
  ];
  for (const input of malformed) {
    assert.equal(isMalformedAreaUrl(input), true, input);
    assert.equal(canonicalDashboardPath(input), input, input);
  }

  // Not in an area's namespace at all (the first segment is not an area once decoded): untouched, and
  // therefore classified by the existing default. `/proxy%2Fproviders` is one segment named
  // "proxy/providers", which no rewrite matches.
  for (const input of [
    "/proxy%2Fproviders",
    "/proxy%2fproviders/x",
    "/pro%2Fxy/providers",
    "/proxyproviders",
  ]) {
    assert.equal(isAreaUrl(input), false, input);
    assert.equal(isMalformedAreaUrl(input), false, input);
    assert.equal(canonicalDashboardPath(input), input, input);
  }

  // Area URLs with no page behind them stay unmapped (404 by Next; management by the classifier).
  for (const input of [
    "/proxy",
    "/proxy/",
    "/proxy/unknown",
    "/home/unknown",
    "/system/mitm-proxy",
    "/PROXY/onboarding",
    // The URLs of an earlier release that are now only redirected (no rewrite of their own).
    "/proxy/api-manager",
    "/proxy/quota",
    "/observe/free-tiers",
    "/optimize/context",
    "/optimize/compression/studio",
    "/agents/agent-bridge",
    "/tools/traffic-inspector",
    "/system/proxy",
  ]) {
    assert.equal(isAreaUrl(input), true, input);
    assert.equal(canonicalDashboardPath(input), input, input);
  }
  assert.equal(canonicalDashboardPath("/home/onboarding"), "/home/onboarding");
});

test("no area URL is ever mapped outside /dashboard, so none can reach a lower-privilege class", () => {
  const variants = (value: string) => [
    value,
    value.toUpperCase(),
    value.replace(/\//g, "//"),
    `${value}/`,
    `${value}/x/y`,
    `${value.slice(0, 2)}%${value.charCodeAt(2).toString(16)}${value.slice(3)}`,
  ];
  for (const rule of dashboardUrlRules()) {
    for (const variant of variants(rule.newPrefix)) {
      const served = canonicalDashboardPath(variant);
      assert.ok(served.startsWith(rule.oldPrefix), `${variant} -> ${served}`);
      assert.ok(served.startsWith("/dashboard/"), `${variant} -> ${served}`);
    }
  }
});

test("findNavMatch accepts both URL forms, and the resolved menu links to the area URLs", () => {
  const sections = resolveNavSections(none, {});
  for (const [oldUrl, newUrl, label, area] of [
    ["/dashboard/providers", "/proxy/providers", "Providers", "proxy"],
    ["/dashboard/providers/openai", "/proxy/providers/openai", "Providers", "proxy"],
    ["/dashboard/providers/services", "/proxy/providers/services", "Local services", "proxy"],
    ["/dashboard/models", "/proxy/models", "Models", "proxy"],
    ["/dashboard/context/caveman", "/optimize/token-saver/engines/caveman", "Engines", "optimize"],
    ["/dashboard/compression/studio", "/optimize/token-saver/studio", "Studio", "optimize"],
    ["/dashboard/analytics", "/home/analytics", "Usage", "home"],
    [
      "/dashboard/analytics/compression",
      "/optimize/token-saver/analytics",
      "Analytics",
      "optimize",
    ],
    ["/dashboard/settings/sidebar", "/system/settings/sidebar", "Sidebar", "system"],
    ["/dashboard/settings/general", "/system/settings/storage", "Storage", "system"],
    ["/dashboard/tools/agent-bridge", "/agents/bridge", "Agent bridge", "agents"],
    ["/dashboard/tools/traffic-inspector", "/tools/inspector", "Inspector", "tools"],
    ["/dashboard/free-tiers", "/proxy/providers/free-tiers", "Free tiers", "proxy"],
    ["/dashboard/free-provider-rankings", "/proxy/providers/rankings", "Rankings", "proxy"],
    ["/dashboard/radar/intel", "/proxy/providers/radar/intel", "Radar", "proxy"],
    ["/dashboard/quota", "/observe/costs/quota", "Quota", "observe"],
    ["/dashboard/combos/playground", "/proxy/combos/test", "Test combo", "proxy"],
    ["/dashboard/runtime", "/observe/health/runtime", "Runtime", "observe"],
    ["/dashboard/activity", "/observe/logs/activity", "Activity", "observe"],
    ["/dashboard/mcp", "/proxy/mcp", "Endpoint", "proxy"],
    ["/home", "/home", "Topology", "home"],
  ] as const) {
    for (const url of [
      oldUrl,
      newUrl,
      newUrl.replace(/^\/[^/]+/, (first) => first.toUpperCase()),
    ]) {
      const match = findNavMatch(url, sections);
      assert.equal(match?.tab.label, label, url);
      assert.equal(match?.section.id, area, url);
    }
  }
  assert.equal(findNavMatch("/proxy/nowhere", sections), null);
  assert.equal(findNavMatch("/dashboard/nowhere", sections), null);

  // The menu links to the area URLs; external pages are left alone.
  const hrefs = sections.flatMap((section) =>
    section.entries.flatMap((entry) => [entry.href, ...entry.tabs.map((tab) => tab.href)])
  );
  assert.ok(hrefs.includes("/proxy/providers"));
  assert.ok(hrefs.includes("/observe/logs/console"));
  assert.ok(hrefs.includes("/proxy/keys"));
  assert.ok(hrefs.includes("/optimize/token-saver/engines"));
  assert.ok(hrefs.includes("/home"));
  assert.ok(hrefs.includes("/docs"));
  assert.ok(hrefs.includes("https://github.com/reddb-io/red-router/issues"));
  assert.deepEqual(
    hrefs.filter((href) => href.startsWith("/dashboard/")),
    [],
    "every internal menu link is an area URL"
  );
});

test("hiding pages is by id, so nothing stored depends on a URL", () => {
  const hidden = new Set(["providers", "costs-free-tiers"]);
  const entry = resolveNavSections(hidden, {})
    .flatMap((section) => section.entries)
    .find((candidate) => candidate.id === "providers");
  assert.ok(entry);
  assert.deepEqual(
    entry.tabs.map((tab) => tab.id ?? tab.href),
    [
      "free-provider-rankings",
      "radar",
      "embedded-services",
      "/proxy/media-providers",
      "/proxy/relay",
    ]
  );
  assert.equal(entry.href, "/proxy/providers/rankings");
});
