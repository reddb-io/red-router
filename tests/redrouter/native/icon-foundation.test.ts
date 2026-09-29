import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Icon, { ICON_COLORS, ICON_SIZES } from "../../../src/shared/components/Icon.tsx";
import {
  MATERIAL_TO_LUCIDE,
  lucideForMaterial,
} from "../../../src/shared/icons/materialToLucide.ts";
import { NAV_ICONS, navIcon } from "../../../src/shared/icons/navIcons.ts";
import { SIDEBAR_NAV_SECTIONS } from "../../../src/shared/constants/sidebarNav.ts";
import { SIDEBAR_SECTIONS } from "../../../src/shared/constants/sidebarVisibility/sections.ts";

const require = createRequire(import.meta.url);
const lucide = require("lucide-react") as Record<string, unknown>;

const DS_ICON = "/home/cyber/Work/reddb.io/design-system/kits/base/src/Icon.svelte";

const parseList = (source: string, name: string): string[] => {
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
  assert.ok(match, `${name} not found in the design-system Icon`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

/** Every string `icon` property found anywhere in a nested structure. */
const collectIcons = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectIcons(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "icon" && typeof child === "string") out.add(child);
      else collectIcons(child, out);
    }
  }
  return out;
};

test("ICON_SIZES and ICON_COLORS are the design-system lists", () => {
  assert.deepEqual([...ICON_SIZES], ["sm", "md", "lg"]);
  assert.deepEqual(
    [...ICON_COLORS],
    [
      "current",
      "foreground",
      "ink-muted",
      "muted",
      "primary",
      "on-primary",
      "feedback-danger-foreground",
      "feedback-success-foreground",
      "feedback-warning-foreground",
    ]
  );
});

test("the lists match the design-system Icon.svelte when it is on disk", (t) => {
  if (!fs.existsSync(DS_ICON)) {
    t.skip("design-system checkout not present");
    return;
  }
  const source = fs.readFileSync(DS_ICON, "utf8");
  assert.deepEqual([...ICON_SIZES], parseList(source, "ICON_SIZES"));
  assert.deepEqual([...ICON_COLORS], parseList(source, "ICON_COLORS"));
});

test("every MATERIAL_TO_LUCIDE value is a real lucide-react export", () => {
  const missing = Object.entries(MATERIAL_TO_LUCIDE)
    .filter(([, glyph]) => typeof lucide[glyph] !== "object" && typeof lucide[glyph] !== "function")
    .map(([material, glyph]) => `${material} -> ${glyph}`);
  assert.deepEqual(missing, []);
});

test("every NAV_ICONS key is a real lucide-react export bound to that glyph", () => {
  for (const [name, glyph] of Object.entries(NAV_ICONS)) {
    assert.equal(glyph, lucide[name], `${name} is not the lucide export of that name`);
  }
});

test("every Material icon the sidebar uses is mapped and has a shell glyph", () => {
  const names = new Set<string>();
  collectIcons(SIDEBAR_SECTIONS, names);
  collectIcons(SIDEBAR_NAV_SECTIONS, names);
  assert.ok(names.size > 40, `expected many sidebar icons, found ${names.size}`);

  const unmapped: string[] = [];
  const notInNav: string[] = [];
  for (const name of names) {
    // Names already expressed as lucide exports need no mapping.
    if (name in NAV_ICONS) continue;
    const lucideName = lucideForMaterial(name);
    if (!lucideName) unmapped.push(name);
    else if (!(lucideName in NAV_ICONS)) notInNav.push(`${name} -> ${lucideName}`);
  }
  assert.deepEqual(unmapped, [], "add these to MATERIAL_TO_LUCIDE");
  assert.deepEqual(notInNav, [], "add these glyphs to NAV_ICONS");
});

test("the area and rail glyphs are registered", () => {
  for (const name of [
    "House",
    "Waypoints",
    "Gauge",
    "Bot",
    "Activity",
    "Wrench",
    "Settings",
    "Search",
    "PanelLeftClose",
    "PanelLeftOpen",
    "RotateCw",
    "Power",
    "Pin",
    "PinOff",
    "ChevronDown",
    "ChevronRight",
    "X",
    "Ellipsis",
  ]) {
    assert.ok(NAV_ICONS[name], `${name} missing from NAV_ICONS`);
  }
});

test("navIcon resolves lucide names, Material names, and falls back for unknown ones", () => {
  assert.equal(navIcon("House"), NAV_ICONS.House);
  assert.equal(navIcon("home"), NAV_ICONS.House);
  assert.equal(navIcon("rocket_launch"), NAV_ICONS.Rocket);
  assert.equal(navIcon("definitely_not_an_icon"), NAV_ICONS.Circle);
  assert.equal(navIcon("constructor"), NAV_ICONS.Circle);
  assert.equal(lucideForMaterial("definitely_not_an_icon"), undefined);
  assert.equal(lucideForMaterial("toString"), undefined);
});

test("Icon renders a decorative, stroke-2, token-coloured svg", () => {
  const html = renderToStaticMarkup(createElement(Icon, { icon: NAV_ICONS.House }));
  assert.match(html, /^<svg\b/);
  assert.match(html, /stroke-width="2"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /width:var\(--reddb-spatial-icon-size-md\)/);
  assert.match(html, /height:var\(--reddb-spatial-icon-size-md\)/);
  assert.match(html, /\bshrink-0\b/);
  assert.match(html, /\btext-foreground\b/);
});

test("Icon never emits a hex colour or a Tailwind palette class", () => {
  for (const color of ICON_COLORS) {
    for (const size of ICON_SIZES) {
      const html = renderToStaticMarkup(createElement(Icon, { icon: NAV_ICONS.Bot, size, color }));
      assert.ok(!html.includes("#"), `hex colour in ${color}/${size}: ${html}`);
      assert.doesNotMatch(
        html,
        /\btext-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d/
      );
      assert.match(html, new RegExp(`--reddb-spatial-icon-size-${size}`));
    }
  }
});

test("a labelled Icon is exposed to assistive technology", () => {
  const html = renderToStaticMarkup(
    createElement(Icon, { icon: NAV_ICONS.Search, "aria-label": "Search", color: "primary" })
  );
  assert.doesNotMatch(html, /aria-hidden/);
  assert.match(html, /aria-label="Search"/);
  assert.match(html, /\btext-primary\b/);
});

test("Icon ignores a stroke width supplied by a JS caller", () => {
  const html = renderToStaticMarkup(
    createElement(Icon, {
      icon: NAV_ICONS.Bot,
      // @ts-expect-error the stroke width is fixed by the contract and not a prop
      strokeWidth: 5,
    })
  );
  assert.match(html, /stroke-width="2"/);
});
