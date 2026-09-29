import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

const sidebar = read("src/shared/components/Sidebar.tsx");
const rail = read("src/shared/components/shell/SidebarRail.tsx");
const panel = read("src/shared/components/shell/SidebarPanel.tsx");
const tabs = read("src/shared/components/RouteTabs.tsx");

test("the side rail and panel render through the design system's contracts", () => {
  assert.ok(rail.includes("design-system/contracts/sidebar-rail.variants"));
  assert.ok(panel.includes("design-system/contracts/sidebar-navigation.variants"));
  assert.ok(panel.includes("design-system/contracts/nav-item.variants"));
  assert.ok(panel.includes("navItem({ active })"));
  assert.ok(tabs.includes("design-system/contracts/tabs.variants"));
  // The old selection language was a tinted red fill.
  for (const source of [sidebar, rail, panel, tabs]) {
    assert.equal(source.includes("bg-primary/10 text-primary"), false);
  }
});

test("the sidebar carries no OmniRoute chrome", () => {
  assert.equal(sidebar.includes("OmniRouteLogo"), false);
  // Decorative macOS window-control dots and the gradient logo tile are gone.
  for (const colour of ["#FF5F56", "#FFBD2E", "#27C93F", "from-[#E54D5E]"]) {
    assert.equal(sidebar.includes(colour), false, colour);
  }
});

test("navigation icons are lucide glyphs in the design system's neutral ink, never rainbow", () => {
  for (const [name, source] of [
    ["Sidebar", sidebar],
    ["SidebarRail", rail],
    ["SidebarPanel", panel],
    ["RouteTabs", tabs],
  ] as const) {
    assert.equal(source.includes("material-symbols-outlined"), false, `${name} uses Material`);
    assert.equal(source.includes("getSidebarIconAccent"), false, `${name} colours icons`);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, `${name} has a hex colour`);
    assert.equal(
      /\b(text|bg|border)-(amber|red|emerald|green|blue|sky|cyan|teal|violet|purple|pink|rose|orange|yellow|lime|fuchsia|indigo)-\d/.test(
        source
      ),
      false,
      `${name} uses a palette colour`
    );
  }
});
