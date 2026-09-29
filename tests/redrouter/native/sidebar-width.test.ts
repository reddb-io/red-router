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
  assert.equal(sidebarWidthForKey(240, "ArrowRight"), 248);
  assert.equal(sidebarWidthForKey(240, "ArrowLeft"), 232);
  assert.equal(sidebarWidthForKey(240, "ArrowRight", true), 232);
  assert.equal(sidebarWidthForKey(SIDEBAR_MAX_WIDTH, "ArrowRight"), SIDEBAR_MAX_WIDTH);
  assert.equal(sidebarWidthForKey(SIDEBAR_MIN_WIDTH, "ArrowLeft"), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarWidthForKey(240, "Home"), SIDEBAR_MIN_WIDTH);
  assert.equal(sidebarWidthForKey(240, "End"), SIDEBAR_MAX_WIDTH);
  assert.equal(sidebarWidthForKey(240, "a"), null);
});

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

test("the sidebar is one-line, compact and driven by the width variable", () => {
  const sidebar = read("src/shared/components/Sidebar.tsx");
  assert.ok(sidebar.includes('data-density="compact"'));
  assert.ok(sidebar.includes("w-[var(--rr-sidebar-width,240px)]"));
  assert.equal(sidebar.includes("w-[220px]"), false);
  // The subtitle is no longer a second line; it is the row's tooltip.
  assert.equal(sidebar.includes("text-[10px] text-text-muted/60"), false);
  assert.ok(sidebar.includes("title={rowTitle}"));
});

test("the desktop layout owns the width and renders the resize handle", () => {
  const layout = read("src/shared/components/layouts/DashboardLayout.tsx");
  assert.ok(layout.includes('"--rr-sidebar-width"'));
  assert.ok(layout.includes("<SidebarResizeHandle"));
  const handle = read("src/shared/components/SidebarResizeHandle.tsx");
  assert.ok(handle.includes('role="separator"'));
  assert.ok(handle.includes("onDoubleClick"));
});
