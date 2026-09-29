import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
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
    assert.equal(reachable.get(item.id), item.href, `${item.id} points somewhere else`);
  }
  for (const tab of allNavTabs()) {
    if (tab.id)
      assert.ok((HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes(tab.id), tab.id);
  }
});

test("a page appears in one place only", () => {
  const seen = new Set<string>();
  for (const tab of allNavTabs()) {
    assert.equal(seen.has(tab.href), false, `${tab.href} is listed twice`);
    seen.add(tab.href);
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
  assert.equal(resolveNavEntry(logs, none)?.href, "/dashboard/logs");
  const withoutFirst = resolveNavEntry(logs, new Set(["logs"]));
  assert.equal(withoutFirst?.href, "/dashboard/logs/proxy");
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
    resolveNavEntry(combos, none)?.tabs.some((tab) => tab.href === "/dashboard/combos/playground")
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
  assert.equal(findNavMatch("/dashboard/skills", sections)?.entry.label, "Skills");
  assert.equal(findNavMatch("/dashboard/skills/styles", sections)?.tab.label, "Prompt styles");
  assert.equal(findNavMatch("/home", sections)?.entry.id, "analytics");
  assert.equal(findNavMatch("/home", sections)?.tab.label, "Topology");
  assert.equal(findNavMatch("/dashboard/analytics", sections)?.section.id, "home");
  assert.equal(findNavMatch("/dashboard/nowhere", sections), null);
});

test("Radar follows its feature flag", () => {
  const off = resolveNavSections(none, { RADAR_ENABLED: false });
  assert.ok(!off.flatMap((s) => s.entries).some((e) => e.tabs.some((tab) => tab.id === "radar")));
  const on = resolveNavSections(none, { RADAR_ENABLED: true });
  assert.ok(on.flatMap((s) => s.entries).some((e) => e.tabs.some((tab) => tab.id === "radar")));
});

test("the presets keep a usable menu", () => {
  for (const preset of SIDEBAR_PRESETS) {
    const entries = resolveNavSections(new Set(preset.hiddenItems), {}).flatMap((s) => s.entries);
    assert.ok(entries.length > 0, preset.id);
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
    ["Home", "Proxy", "Optimize", "Agents", "Observe", "Tools", "System"]
  );
  for (const section of SIDEBAR_NAV_SECTIONS) {
    assert.ok(section.icon, `${section.id} has a rail icon`);
    assert.ok(section.entries.length <= 12, `${section.id} panel stays short`);
  }
  const labs = SIDEBAR_NAV_SECTIONS.flatMap((s) => s.entries).filter((e) => e.group === "Labs");
  assert.deepEqual(
    labs.map((e) => e.id),
    ["chaos", "gamification", "batch"]
  );
});

test("Quota lives with Providers and Integrations with Observe", () => {
  const sections = resolveNavSections(none, {});
  assert.equal(findNavMatch("/dashboard/quota", sections)?.entry.id, "providers");
  assert.equal(findNavMatch("/dashboard/quota", sections)?.section.id, "proxy");
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
  assert.equal(home?.entries[0].href, "/dashboard/analytics");
  assert.match(
    readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8"),
    /redirect\("\/dashboard\/analytics"\)/
  );
  assert.ok(
    readFileSync("src/shared/components/Sidebar.tsx", "utf8").includes(
      'href="/dashboard/analytics"'
    )
  );
  // Usage exists once: it is not repeated under Observe.
  const observe = sections.find((section) => section.id === "observe");
  assert.equal(
    observe?.entries.some((entry) => entry.id === "analytics"),
    false
  );
});
