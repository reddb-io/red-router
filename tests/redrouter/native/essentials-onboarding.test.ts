import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  HIDEABLE_SIDEBAR_ITEM_IDS,
  SIDEBAR_PRESETS,
  resolveHiddenSidebarItems,
} from "../../../src/shared/constants/sidebarVisibility.ts";
import { resolveNavSections } from "../../../src/shared/constants/sidebarNav.ts";

const legacyShown = new Set([
  "home",
  "endpoints",
  "api-manager",
  "providers",
  "health",
  "settings-general",
  "settings-sidebar",
]);
const legacyHidden = HIDEABLE_SIDEBAR_ITEM_IDS.filter((id) => !legacyShown.has(id));

test("saved unmodified Essentials gains Setup, Models and the Access rail", () => {
  const hidden = resolveHiddenSidebarItems({
    hiddenSidebarItems: [...legacyHidden].reverse(),
    sidebarActivePreset: "essentials",
  });
  assert.deepEqual(
    hidden,
    SIDEBAR_PRESETS.find((preset) => preset.id === "essentials")!.hiddenItems
  );
  const sections = resolveNavSections(new Set(hidden), {});
  assert.ok(
    sections.find((section) => section.id === "home")?.entries.some((entry) => entry.id === "setup")
  );
  assert.ok(
    sections
      .find((section) => section.id === "proxy")
      ?.entries.some((entry) => entry.id === "model-catalog")
  );
  assert.deepEqual(
    sections.find((section) => section.id === "access")?.entries.map((entry) => entry.label),
    ["Tenants", "Users", "Roles"]
  );
});

test("Essentials saved before Network and Prompts gains both without changing custom visibility", () => {
  const before = legacyHidden.filter(
    (id) => id !== "settings-network" && id !== "settings-prompts"
  );
  const hidden = resolveHiddenSidebarItems({
    hiddenSidebarItems: before,
    sidebarActivePreset: "essentials",
  });
  assert.equal(hidden.includes("settings-network"), false);
  assert.equal(hidden.includes("settings-prompts"), false);
  assert.deepEqual(
    hidden,
    SIDEBAR_PRESETS.find((preset) => preset.id === "essentials")!.hiddenItems
  );
  assert.deepEqual(
    resolveHiddenSidebarItems({ hiddenSidebarItems: before, sidebarActivePreset: null }),
    before
  );
});

test("custom hides and a customized list carrying a stale preset are preserved", () => {
  assert.deepEqual(
    resolveHiddenSidebarItems({ hiddenSidebarItems: legacyHidden, sidebarActivePreset: null }),
    legacyHidden
  );
  const changed = HIDEABLE_SIDEBAR_ITEM_IDS.filter(
    (id) => legacyHidden.includes(id) || id === "providers"
  );
  assert.deepEqual(
    resolveHiddenSidebarItems({ hiddenSidebarItems: changed, sidebarActivePreset: "essentials" }),
    changed
  );
  assert.deepEqual(
    new Set(
      resolveHiddenSidebarItems({
        hiddenSidebarItems: ["setup", "model-catalog", "tenants"],
        sidebarActivePreset: "admin",
      })
    ),
    new Set(["setup", "model-catalog", "tenants"])
  );
});

const dir = mkdtempSync(join(tmpdir(), "redrouter-home-activity-"));
process.env.DATA_DIR = dir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { hasRecordedRequestActivity } = await import("../../../src/lib/db/usageSummary.ts");
const { loadHomeActivity, loadHomeSettings } =
  await import("../../../src/app/(dashboard)/home/loadHomeSettings.ts");
after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("first-use evidence includes retained raw requests, rollups and ledger-only activity", () => {
  const db = getDbInstance();
  assert.equal(hasRecordedRequestActivity(), false);
  db.prepare("INSERT INTO usage_history (timestamp, success) VALUES (?, ?)").run(
    "2025-01-01T00:00:00.000Z",
    0
  );
  assert.equal(
    hasRecordedRequestActivity(),
    true,
    "failed requests still prove the instance has been used"
  );
  db.prepare("DELETE FROM usage_history").run();
  db.prepare(
    "INSERT INTO daily_usage_summary (provider, model, date, total_requests) VALUES (?, ?, ?, ?)"
  ).run("openai", "fixture", "2024-01-01", 0);
  assert.equal(hasRecordedRequestActivity(), false, "an empty rollup is not evidence");
  db.prepare("UPDATE daily_usage_summary SET total_requests = 1").run();
  assert.equal(hasRecordedRequestActivity(), true);
  db.prepare("DELETE FROM daily_usage_summary").run();
  db.prepare(
    "INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp) VALUES (?, ?, ?, ?, ?)"
  ).run("fixture-key", "openai", "fixture", 0, "2025-01-01T00:00:00.000Z");
  assert.equal(hasRecordedRequestActivity(), true, "zero charge is still an observed request");
});

test("display-only failures suppress the first-request prompt without changing auth settings", async () => {
  assert.equal(
    await loadHomeActivity(() => {
      throw new Error("missing activity source");
    }),
    null
  );
  assert.equal(await loadHomeActivity(() => false), false);
  assert.deepEqual(await loadHomeSettings(async () => ({ setupComplete: true })), {
    setupComplete: true,
  });
  assert.deepEqual(
    await loadHomeSettings(async () => {
      throw new Error("missing settings");
    }),
    { setupComplete: false }
  );
});
