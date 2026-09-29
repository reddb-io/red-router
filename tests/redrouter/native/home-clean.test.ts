import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the Home page carries no partner banners and no Quick Start panel", () => {
  const page = readFileSync("src/app/(dashboard)/home/page.tsx", "utf8");
  for (const banner of [
    "KimiSponsorBanner",
    "CheaperInferenceSponsorBanner",
    "VscodeCopilotBanner",
  ]) {
    assert.equal(page.includes(banner), false, banner);
  }
  const client = readFileSync("src/app/(dashboard)/dashboard/HomePageClient.tsx", "utf8");
  assert.equal(client.includes("quickStart"), false);
  assert.equal(client.includes("showQuickStartOnHome"), false);
  for (const file of [
    "KimiSponsorBanner",
    "CheaperInferenceSponsorBanner",
    "VscodeCopilotBanner",
  ]) {
    assert.equal(existsSync(`src/app/(dashboard)/dashboard/${file}.tsx`), false, file);
  }
});
