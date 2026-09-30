import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { areaUrl } from "../../../src/shared/constants/dashboardUrls.ts";
import {
  SIDEBAR_NAV_SECTIONS,
  allNavTabs,
  findNavMatch,
  resolveNavEntry,
  resolveNavSections,
  splitNavTabs,
} from "../../../src/shared/constants/sidebarNav.ts";
import {
  HIDEABLE_SIDEBAR_ITEM_IDS,
  SIDEBAR_PRESETS,
  SIDEBAR_SECTIONS,
  getSectionItems,
} from "../../../src/shared/constants/sidebarVisibility.ts";
import { OUTPUT_STYLE_IDS } from "../../../open-sse/services/compression/outputStyles/catalog.ts";

const none = new Set<string>();

test("the menu is a short list of entries, not a page index", () => {
  const entries = SIDEBAR_NAV_SECTIONS.flatMap((section) => section.entries);
  assert.ok(entries.length <= 34, `${entries.length} entries`);
  assert.ok(SIDEBAR_NAV_SECTIONS.length <= 8);
  assert.equal(
    new Set(entries.map((entry) => entry.id)).size,
    entries.length,
    "entry ids are unique"
  );
  // The old registry it groups had far more rows; that is what made the sidebar too tall.
  const registry = SIDEBAR_SECTIONS.flatMap((section) => getSectionItems(section));
  assert.ok(registry.length > 80);
});

test("every page the old menu listed is still reachable from the new one", () => {
  const registry = SIDEBAR_SECTIONS.flatMap((section) => getSectionItems(section));
  const reachable = new Map(
    allNavTabs().flatMap((tab) => (tab.id ? [[tab.id, tab.href] as const] : []))
  );
  // Stored settings and pins refer to these ids; only Radar's runtime-only admin link is added later.
  for (const item of registry) {
    if (item.id === "proxy" || item.id === "radar-admin") continue;
    assert.ok(reachable.has(item.id), `${item.id} has no place in the menu`);
    // The registry links to the area URL of the page the menu names by its real path.
    assert.equal(
      areaUrl(reachable.get(item.id) ?? ""),
      item.href,
      `${item.id} points somewhere else`
    );
  }
  for (const tab of allNavTabs()) {
    if (tab.id)
      assert.ok((HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes(tab.id), tab.id);
  }
});

test("a page appears in one place only, and no two tabs share a URL", () => {
  const seen = new Set<string>();
  const shown = new Map<string, string>();
  for (const tab of allNavTabs()) {
    assert.equal(seen.has(tab.href), false, `${tab.href} is listed twice`);
    seen.add(tab.href);
    // Two pages must not be shown at one URL either (an override that collides would hide one).
    const url = areaUrl(tab.href);
    assert.equal(
      shown.has(url),
      false,
      `${tab.href} and ${shown.get(url)} are both shown at ${url}`
    );
    shown.set(url, tab.href);
  }
  // Nor within an entry: a tab bar never has two tabs that open the same page.
  for (const entry of SIDEBAR_NAV_SECTIONS.flatMap((section) => section.entries)) {
    const urls = entry.tabs.map((tab) => areaUrl(tab.href));
    assert.equal(new Set(urls).size, urls.length, `${entry.id} repeats a tab`);
    assert.equal(
      new Set(entry.tabs.map((tab) => tab.label)).size,
      entry.tabs.length,
      `${entry.id} repeats a label`
    );
  }
});

const dashboardRoot = path.resolve("src/app/(dashboard)");
function pageRoutes(dir: string, prefix = ""): string[] {
  const routes: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      routes.push(...pageRoutes(full, `${prefix}/${name}`));
    } else if (name === "page.tsx") {
      routes.push(prefix || "/");
    }
  }
  return routes;
}

// Pages that are not menu destinations on purpose.
const OFF_MENU: Record<string, string> = {
  "/dashboard": "redirects to /home",
  "/dashboard/auto-combo": "redirects to Combos",
  "/dashboard/compression": "redirects into Token saver",
  "/dashboard/context": "redirects into Token saver",
  "/dashboard/limits": "redirects to Quota",
  "/dashboard/usage": "redirects to Logs",
  "/dashboard/logs/activity": "redirects to Activity",
  "/dashboard/settings": "settings index, opens the first tab",
  "/dashboard/settings/pricing": "redirects to Costs > Pricing",
  "/dashboard/system/1proxy": "redirects to Outbound proxies",
  "/dashboard/system/mitm-proxy": "redirects to Agent bridge",
  "/dashboard/onboarding": "first-run wizard, opened by Setup",
};

test("every tab (and every detail page) opens a real page", () => {
  const routes = new Set(
    pageRoutes(dashboardRoot).map((route) => route.replace(/\/\([^/]+\)/g, ""))
  );
  for (const tab of allNavTabs()) {
    if (tab.external) continue;
    assert.ok(routes.has(tab.href), `${tab.label}: ${tab.href} has no page.tsx`);
  }
  // The external tabs are the docs (a route of the app) and the issue tracker.
  for (const tab of allNavTabs().filter((candidate) => candidate.external)) {
    assert.ok(tab.href.startsWith("https://") || tab.href.startsWith("/"), tab.href);
  }
  assert.ok(existsSync(path.resolve("src/app/docs")), "/docs is an app route");
});

test("the off-menu list has no stale entry: each one is still a page", () => {
  const routes = new Set(
    pageRoutes(dashboardRoot).map((route) => route.replace(/\/\([^/]+\)/g, ""))
  );
  for (const route of Object.keys(OFF_MENU)) {
    assert.ok(routes.has(route), `${route} is listed as off-menu but is not a page any more`);
  }
});

test("every dashboard page is a menu page, a detail of one, or listed as off-menu", () => {
  const tabs = allNavTabs().filter((tab) => !tab.external);
  const uncovered = pageRoutes(dashboardRoot)
    .map((route) => route.replace(/\/\([^/]+\)/g, ""))
    .filter((route) => {
      if (route in OFF_MENU) return false;
      return !tabs.some((tab) =>
        tab.exact ? route === tab.href : route === tab.href || route.startsWith(`${tab.href}/`)
      );
    });
  assert.deepEqual(uncovered, []);
});

test("an entry opens on its first visible page and disappears when all of them are hidden", () => {
  const logs = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find((entry) => entry.id === "logs");
  assert.ok(logs);
  // The menu shows area URLs (see dashboard-urls.test.ts); the page files stay under /dashboard.
  assert.equal(resolveNavEntry(logs, none)?.href, "/observe/logs");
  const withoutFirst = resolveNavEntry(logs, new Set(["logs"]));
  assert.equal(withoutFirst?.href, "/observe/logs/proxy");
  assert.ok(!withoutFirst?.tabs.some((tab) => tab.id === "logs"));
  const everything = new Set(logs.tabs.flatMap((tab) => (tab.id ? [tab.id] : [])));
  assert.equal(resolveNavEntry(logs, everything), null);
});

test("pages that were never separate menu items follow their entry", () => {
  const combos = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find(
    (entry) => entry.id === "combos"
  );
  assert.ok(combos);
  const onlyPlayground = new Set(combos.tabs.flatMap((tab) => (tab.id ? [tab.id] : [])));
  assert.equal(
    resolveNavEntry(combos, onlyPlayground),
    null,
    "a page without an id keeps nothing alive"
  );
  assert.ok(
    resolveNavEntry(combos, none)?.tabs.some(
      (tab) => tab.href === "/proxy/combos/test" && tab.label === "Test combo"
    )
  );
});

test("a URL belongs to the entry with the longest matching page", () => {
  const sections = resolveNavSections(none, {});
  assert.equal(
    findNavMatch("/dashboard/providers/services", sections)?.tab.label,
    "Local services"
  );
  assert.equal(findNavMatch("/dashboard/providers/abc", sections)?.tab.label, "Providers");
  assert.equal(findNavMatch("/dashboard/context/caveman", sections)?.entry.id, "token-saver");
  assert.equal(
    findNavMatch("/optimize/token-saver/engines/caveman", sections)?.tab.label,
    "Engines"
  );
  assert.equal(findNavMatch("/dashboard/skills", sections)?.entry.label, "Skills");
  assert.equal(findNavMatch("/dashboard/skills/styles", sections)?.tab.label, "Prompt styles");
  assert.equal(findNavMatch("/home", sections)?.entry.id, "analytics");
  assert.equal(findNavMatch("/home", sections)?.tab.label, "Topology");
  assert.equal(findNavMatch("/dashboard/analytics", sections)?.section.id, "home");
  assert.equal(findNavMatch("/dashboard/nowhere", sections), null);
});

test("Radar follows its feature flag and its hide preference, from its place under Providers", () => {
  const entryOf = (sections: ReturnType<typeof resolveNavSections>, id: string) =>
    sections.flatMap((s) => s.entries).find((e) => e.id === id);
  const off = resolveNavSections(none, { RADAR_ENABLED: false });
  assert.ok(!off.flatMap((s) => s.entries).some((e) => e.tabs.some((tab) => tab.id === "radar")));
  const on = resolveNavSections(none, { RADAR_ENABLED: true });
  const providers = entryOf(on, "providers");
  assert.ok(
    providers?.tabs.some((tab) => tab.id === "radar" && tab.href === "/proxy/providers/radar")
  );
  assert.equal(
    entryOf(on, "costs")?.tabs.some((tab) => tab.id === "radar"),
    false
  );
  // The stored hidden ids are unchanged, so a saved preference keeps working after the move.
  const hidden = resolveNavSections(new Set(["radar"]), { RADAR_ENABLED: true });
  assert.ok(!entryOf(hidden, "providers")?.tabs.some((tab) => tab.id === "radar"));
  // Without the flag set at all (before the settings arrive) the tab is shown, like before the move.
  assert.ok(
    entryOf(resolveNavSections(none, {}), "providers")?.tabs.some((tab) => tab.id === "radar")
  );
  // The owner-only Radar admin link is added to the entry that now holds Radar, within 8 tabs.
  const withAdmin = resolveNavSections(
    none,
    { RADAR_ENABLED: true },
    {
      providers: [{ href: "https://radar.example/admin", label: "Radar admin ↗", external: true }],
    }
  );
  const tabs = entryOf(withAdmin, "providers")?.tabs ?? [];
  assert.equal(tabs.at(-1)?.label, "Radar admin ↗");
  assert.ok(splitNavTabs(tabs).primary.length <= 8);
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    [
      "Providers",
      "Free tiers",
      "Rankings",
      "Radar",
      "Local services",
      "Media providers",
      "Relay",
      "Radar admin ↗",
    ]
  );
});

test("Providers and Costs list their tabs in the agreed order", () => {
  const entries = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries);
  assert.deepEqual(
    entries.find((e) => e.id === "providers")?.tabs.map((tab) => tab.label),
    ["Providers", "Free tiers", "Rankings", "Radar", "Local services", "Media providers", "Relay"]
  );
  assert.deepEqual(
    entries.find((e) => e.id === "costs")?.tabs.map((tab) => tab.label),
    ["Overview", "Pricing", "Budget", "Quota", "Quota sharing"]
  );
  assert.deepEqual(
    entries.find((e) => e.id === "combos")?.tabs.map((tab) => tab.label),
    ["Combos", "Live", "Test combo"]
  );
});

test("the presets keep a usable menu", () => {
  for (const preset of SIDEBAR_PRESETS) {
    const entries = resolveNavSections(new Set(preset.hiddenItems), {}).flatMap((s) => s.entries);
    assert.ok(entries.length > 0, preset.id);
    if (preset.id === "admin") {
      const access = resolveNavSections(new Set(preset.hiddenItems), {}).find(
        (section) => section.id === "access"
      );
      assert.deepEqual(
        access?.entries.map((entry) => entry.label),
        ["Tenants", "Users", "Roles"]
      );
    }
    if (preset.id === "essentials") {
      assert.ok(entries.length <= 8, `essentials shows ${entries.length} entries`);
      for (const id of ["analytics", "endpoint-keys", "providers"]) {
        assert.ok(
          entries.some((entry) => entry.id === id),
          `essentials lacks ${id}`
        );
      }
    }
  }
});

test("Caveman and Ponytail are prompt styles under Skills, not menu entries", () => {
  const skills = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find(
    (entry) => entry.id === "skills"
  );
  assert.deepEqual(
    skills?.tabs.map((tab) => tab.label),
    ["Skills", "Catalog", "Prompt styles"]
  );
  const labels = allNavTabs().map((tab) => tab.label.toLowerCase());
  assert.equal(labels.includes("ponytail"), false);
  assert.ok(OUTPUT_STYLE_IDS.includes("ponytail"));
  const page = readFileSync(
    "src/app/(dashboard)/dashboard/skills/styles/PromptStylesPageClient.tsx",
    "utf8"
  );
  assert.ok(page.includes("OUTPUT_STYLE_IDS"));
  assert.ok(page.includes("Caveman"));
});

test("the rail has one area per job and the panel lists the entries of an area", () => {
  assert.deepEqual(
    SIDEBAR_NAV_SECTIONS.map((section) => section.title),
    ["Home", "Proxy", "Optimize", "Agents", "Observe", "Tools", "Access", "System"]
  );
  for (const section of SIDEBAR_NAV_SECTIONS) {
    assert.ok(section.icon, `${section.id} has a rail icon`);
    assert.ok(section.entries.length <= 12, `${section.id} panel stays short`);
  }
  const labs = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).filter((e) => e.group === "Labs");
  assert.deepEqual(
    labs.map((e) => e.id),
    ["chaos", "batch"]
  );
});

test("Quota lives with Costs, the free-model pages with Providers, and Integrations with Observe", () => {
  const sections = resolveNavSections(none, {});
  assert.equal(findNavMatch("/dashboard/quota", sections)?.entry.id, "costs");
  assert.equal(findNavMatch("/dashboard/quota", sections)?.section.id, "observe");
  for (const page of ["free-tiers", "free-provider-rankings", "radar", "radar/intel"]) {
    const match = findNavMatch(`/dashboard/${page}`, sections);
    assert.equal(match?.entry.id, "providers", page);
    assert.equal(match?.section.id, "proxy", page);
  }
  assert.equal(findNavMatch("/dashboard/webhooks", sections)?.section.id, "observe");
  assert.equal(findNavMatch("/dashboard/provider-stats", sections)?.section.id, "home");
  assert.equal(findNavMatch("/dashboard/playground", sections)?.section.id, "tools");
});

test("every engine page keeps the Engines tab selected instead of being a tab", () => {
  const sections = resolveNavSections(none, {});
  const saver = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find((e) => e.id === "token-saver");
  assert.ok(saver);
  assert.ok(saver.tabs.length <= 8, `${saver.tabs.length} tabs`);
  for (const engine of [
    "caveman",
    "rtk",
    "headroom",
    "session-dedup",
    "ccr",
    "llmlingua",
    "lite",
    "aggressive",
    "ultra",
    "omniglyph",
  ]) {
    const match = findNavMatch(`/dashboard/context/${engine}`, sections);
    assert.equal(match?.entry.id, "token-saver", engine);
    assert.equal(match?.tab.label, "Engines", engine);
  }
  assert.equal(findNavMatch("/dashboard/context/engines", sections)?.tab.label, "Engines");
  assert.equal(findNavMatch("/optimize/token-saver/engines", sections)?.tab.label, "Engines");
  assert.equal(findNavMatch("/optimize/token-saver", sections)?.tab.label, "Overview");
});

test("long entries keep a short tab bar and put the rarely used pages under More", () => {
  const settings = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find((e) => e.id === "settings");
  assert.ok(settings);
  const { primary, more } = splitNavTabs(settings.tabs);
  assert.ok(primary.length <= 8, `${primary.length} primary tabs`);
  assert.deepEqual(
    more.map((tab) => tab.label),
    ["Modality bridge", "Access tokens", "Feature flags", "Cache", "Sidebar", "Outbound proxies"]
  );
  for (const entry of SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries)) {
    assert.ok(splitNavTabs(entry.tabs).primary.length <= 8, `${entry.id} has too many tabs`);
  }
  const short = splitNavTabs(SIDEBAR_NAV_SECTIONS[1].entries[0].tabs);
  assert.deepEqual(short.more, []);
});

test("every icon the menu names is a glyph the shell can draw", async () => {
  const { NAV_ICONS } = await import("../../../src/shared/icons/navIcons.ts");
  for (const section of SIDEBAR_NAV_SECTIONS) {
    assert.ok(section.icon in NAV_ICONS, `${section.id}: ${section.icon}`);
    for (const entry of section.entries) {
      assert.ok(entry.icon in NAV_ICONS, `${entry.id}: ${entry.icon}`);
    }
  }
});

test("Settings → Sidebar edits the menu that is shown, keeps stored ids and keeps itself reachable", () => {
  const editor = readFileSync(
    "src/app/(dashboard)/dashboard/settings/components/SidebarTab.tsx",
    "utf8"
  );
  assert.ok(editor.includes("SIDEBAR_NAV_SECTIONS"));
  assert.ok(editor.includes("SIDEBAR_PRESETS"));
  assert.equal(editor.includes("SIDEBAR_SECTIONS"), false, "the old page registry");
  assert.equal(editor.includes("@dnd-kit"), false, "ordering is gone with the old sections");
  assert.ok(editor.includes('"settings-sidebar"'));
  // Every page of the menu that has an id can be toggled, and the ids are the stored ones.
  for (const tab of allNavTabs()) {
    if (tab.id) assert.ok((HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes(tab.id));
  }
});

test("Home opens on Usage: the landing page, the logo and /dashboard all go there", () => {
  const sections = resolveNavSections(none, {});
  const home = sections.find((section) => section.id === "home");
  assert.equal(home?.entries[0].id, "analytics");
  assert.equal(home?.entries[0].href, "/home/analytics");
  assert.match(
    readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8"),
    /redirect\("\/home\/analytics"\)/
  );
  assert.ok(
    readFileSync("src/shared/components/Sidebar.tsx", "utf8").includes(
      'href={areaUrl("/dashboard/analytics")}'
    )
  );
  // Usage exists once: it is not repeated under Observe.
  const observe = sections.find((section) => section.id === "observe");
  assert.equal(
    observe?.entries.some((entry) => entry.id === "analytics"),
    false
  );
});

test("pages that were in-page tabs are routes, so no page shows two tab bars for the same thing", () => {
  const sections = resolveNavSections(none, {});
  // MCP and A2A live inside the Endpoint page; their own routes keep that tab selected.
  assert.equal(findNavMatch("/dashboard/mcp", sections)?.tab.label, "Endpoint");
  assert.equal(findNavMatch("/dashboard/a2a", sections)?.tab.label, "Endpoint");
  const endpoint = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find(
    (e) => e.id === "endpoint-keys"
  );
  assert.deepEqual(
    endpoint?.tabs.map((tab) => tab.label),
    ["Endpoint", "API keys", "Key routing"]
  );
  // The usage page no longer carries its own tab strip; its siblings are routes.
  const usage = readFileSync("src/app/(dashboard)/dashboard/analytics/page.tsx", "utf8");
  assert.equal(usage.includes('role="tablist"'), false);
  for (const route of ["cache-health", "route-trace"]) {
    assert.ok(
      readFileSync(`src/app/(dashboard)/dashboard/analytics/${route}/page.tsx`, "utf8").length > 0
    );
    assert.equal(findNavMatch(`/dashboard/analytics/${route}`, sections)?.section.id, "home");
  }
});

test("Test combo (Proxy > Combos) is not confused with the free-form Tools > Playground", () => {
  const messages = JSON.parse(readFileSync("src/i18n/messages/en.json", "utf8"));
  assert.equal(messages.combos.playgroundTitle, "Test combo");
  assert.match(messages.combos.playgroundFreeChatHint, /<link>Tools › Playground<\/link>/);
  const client = readFileSync(
    "src/app/(dashboard)/dashboard/combos/playground/ComboPlaygroundClient.tsx",
    "utf8"
  );
  // The one-line pointer under the heading links to the Tools Playground's area URL.
  assert.match(client, /playgroundFreeChatHint[\s\S]{0,200}href="\/tools\/playground"/);
  assert.equal(areaUrl("/dashboard/playground"), "/tools/playground");
  assert.match(
    readFileSync("src/app/(dashboard)/dashboard/combos/playground/page.tsx", "utf8"),
    /Test combo/
  );
  // Tools keeps the name.
  const tools = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).find((e) => e.id === "playground");
  assert.deepEqual(
    tools?.tabs.map((tab) => tab.label),
    ["Playground"]
  );
});
