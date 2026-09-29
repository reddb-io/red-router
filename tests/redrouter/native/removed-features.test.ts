import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SIDEBAR_NAV_SECTIONS } from "../../../src/shared/constants/sidebarNav.ts";
import { SIDEBAR_SECTIONS } from "../../../src/shared/constants/sidebarVisibility/sections.ts";
import { HIDEABLE_SIDEBAR_ITEM_IDS } from "../../../src/shared/constants/sidebarVisibility/types.ts";

const root = process.cwd();
const REMOVED_IDS = ["changelog", "leaderboard", "profile", "tokens", "gamification-admin"];

test("changelog and gamification are gone from the menu", () => {
  const navIds = SIDEBAR_NAV_SECTIONS.flatMap((section) =>
    section.entries.flatMap((entry) => [entry.id, ...entry.tabs.map((tab) => tab.id)])
  );
  for (const id of [...REMOVED_IDS, "gamification"]) {
    assert.ok(!navIds.includes(id), `menu still has ${id}`);
    assert.ok(!(HIDEABLE_SIDEBAR_ITEM_IDS as readonly string[]).includes(id), `${id} is hideable`);
  }
  const registry = JSON.stringify(SIDEBAR_SECTIONS);
  assert.doesNotMatch(registry, /\/dashboard\/(changelog|leaderboard|profile|tokens|gamification)/);
});

test("changelog and gamification code is deleted", () => {
  for (const path of [
    "src/lib/gamification",
    "src/lib/db/gamification.ts",
    "src/app/api/gamification",
    "src/app/(dashboard)/dashboard/changelog",
    "src/app/(dashboard)/dashboard/leaderboard",
    "src/app/(dashboard)/dashboard/gamification",
    "src/app/(dashboard)/dashboard/NewsBanner.tsx",
    "src/shared/utils/releaseNotes.ts",
    "open-sse/mcp-server/tools/gamificationTools.ts",
    "open-sse/handlers/chatCore/gamificationEvent.ts",
  ]) {
    assert.ok(!existsSync(join(root, path)), `${path} should not exist`);
  }
});

test("the MCP server and the request pipeline no longer reference gamification", () => {
  for (const file of [
    "open-sse/mcp-server/server.ts",
    "open-sse/mcp-server/toolSearch/catalog.ts",
    "open-sse/handlers/chatCore.ts",
    "src/lib/radar/intelSync.ts",
  ]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /gamification/i, file);
  }
});

test("removed pages redirect home", () => {
  const config = readFileSync(join(root, "next.config.mjs"), "utf8");
  assert.match(config, /"changelog", "leaderboard", "profile", "tokens"/);
});
