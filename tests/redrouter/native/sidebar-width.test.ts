import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  readSidebarWidth,
  sidebarWidthForKey,
  writeSidebarWidth,
  readSidebarPanelOpen,
  writeSidebarPanelOpen,
} from "../../../src/shared/utils/sidebarWidth.ts";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
};

test("the width stays inside the limits and falls back to the default", () => {
  assert.equal(clampSidebarWidth(1), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(5000), SIDEBAR_MAX_WIDTH);
  assert.equal(clampSidebarWidth("300.4"), 300);
  assert.equal(clampSidebarWidth("wide"), SIDEBAR_DEFAULT_WIDTH);
  assert.equal(clampSidebarWidth(undefined), SIDEBAR_DEFAULT_WIDTH);
});

test("the width is remembered, and a missing or broken store is harmless", () => {
  const storage = memoryStorage();
  assert.equal(readSidebarWidth(storage), SIDEBAR_DEFAULT_WIDTH);
  writeSidebarWidth(310, storage);
  assert.equal(storage.values.get(SIDEBAR_WIDTH_KEY), "310");
  assert.equal(readSidebarWidth(storage), 310);
  writeSidebarWidth(9999, storage);
  assert.equal(readSidebarWidth(storage), SIDEBAR_MAX_WIDTH);
  assert.equal(
    readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: "junk" })),
    SIDEBAR_DEFAULT_WIDTH
  );

  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readSidebarWidth(blocked), SIDEBAR_DEFAULT_WIDTH);
  assert.doesNotThrow(() => writeSidebarWidth(300, blocked));
  assert.equal(readSidebarWidth(null), SIDEBAR_DEFAULT_WIDTH);
});

test("arrow keys resize in steps, Home and End jump to the limits, RTL flips the arrows", () => {
  assert.equal(sidebarWidthForKey(288, "ArrowRight"), 296);
  assert.equal(sidebarWidthForKey(288, "ArrowLeft"), 280);
  assert.equal(sidebarWidthForKey(288, "ArrowRight", true), 280);
  assert.equal(sidebarWidthForKey(SIDEBAR_MAX_WIDTH, "ArrowRight"), SIDEBAR_MAX_WIDTH);
  assert.equal(sidebarWidthForKey(SIDEBAR_MIN_WIDTH, "ArrowLeft"), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarWidthForKey(288, "Home"), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarWidthForKey(288, "End"), SIDEBAR_MAX_WIDTH);
  assert.equal(sidebarWidthForKey(288, "a"), null);
});

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

test("the panel is compact and driven by the width variable, next to a fixed rail", () => {
  const panel = read("src/shared/components/shell/SidebarPanel.tsx");
  assert.ok(panel.includes('data-density="compact"'));
  assert.ok(panel.includes("var(--rr-sidebar-panel-width, 288px)"));
  assert.ok(panel.includes("title={item.description ?? item.label}"));
  // The rail is as wide as the design system says, not as wide as we like.
  assert.equal(read("src/shared/components/shell/SidebarRail.tsx").includes("w-[220px]"), false);
});

test("the panel is 288px by default and stays within the DS showcase limits", () => {
  assert.equal(SIDEBAR_DEFAULT_WIDTH, 288);
  assert.equal(SIDEBAR_MIN_WIDTH, 240);
  assert.equal(SIDEBAR_MAX_WIDTH, 480);
  assert.equal(SIDEBAR_WIDTH_KEY, "sidebar-panel-width");
});

test("the desktop layout owns the panel width and renders the resize handle", () => {
  const layout = read("src/shared/components/layouts/DashboardLayout.tsx");
  assert.ok(layout.includes('"--rr-sidebar-panel-width"'));
  assert.ok(layout.includes("<SidebarResizeHandle"));
  const handle = read("src/shared/components/SidebarResizeHandle.tsx");
  assert.ok(handle.includes('role="separator"'));
  assert.ok(handle.includes("onDoubleClick"));
});

test("the panel is open unless the operator closed it", () => {
  const storage = memoryStorage();
  assert.equal(readSidebarPanelOpen(storage), true);
  writeSidebarPanelOpen(false, storage);
  assert.equal(readSidebarPanelOpen(storage), false);
  writeSidebarPanelOpen(true, storage);
  assert.equal(readSidebarPanelOpen(storage), true);
  assert.equal(readSidebarPanelOpen(null), true);
});
