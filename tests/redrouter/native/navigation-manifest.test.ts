import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allNavTabs,
  findNavPage,
  getNavSearchItems,
} from "../../../src/shared/constants/sidebarNav.ts";
import { areaUrl, canonicalDashboardPath } from "../../../src/shared/constants/dashboardUrls.ts";

test("all canonical pages and detail pages have exactly one searchable destination", () => {
  const items = getNavSearchItems();
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.href)).size, items.length);
  assert.deepEqual(
    new Set(items.map((item) => item.href)),
    new Set(allNavTabs().map((page) => areaUrl(page.href)))
  );
  for (const item of items.filter((item) => !item.external)) {
    assert.equal(findNavPage(item.href)?.href, item.href);
    assert.equal(findNavPage(canonicalDashboardPath(item.href))?.href, item.href);
  }
});
test("hidden pages stay searchable; disabled feature pages and absent private URLs do not appear", () => {
  const hidden = new Set(["setup", "radar", "context-caveman"]);
  const items = getNavSearchItems(hidden, { RADAR_ENABLED: false });
  assert.equal(items.find((item) => item.id === "setup")?.hidden, true);
  assert.equal(items.find((item) => item.id === "context-caveman")?.hidden, true);
  assert.equal(items.find((item) => item.id === "context-caveman")?.label, "Token saver › Caveman");
  assert.equal(
    items.some((item) => item.id === "radar"),
    false
  );
  assert.equal(
    items.some((item) => item.id === "radar-admin"),
    false
  );
  const runtime = getNavSearchItems(
    hidden,
    {},
    {
      providers: [
        {
          id: "radar-admin",
          href: "https://private.example/ops",
          label: "Radar admin ↗",
          external: true,
        },
      ],
    }
  );
  assert.equal(runtime.find((item) => item.id === "radar-admin")?.external, true);
});
test("page titles match segment boundaries and the longest canonical page, including old URLs", () => {
  assert.equal(findNavPage("/proxy/providers/rankings")?.pageLabel, "Rankings");
  assert.equal(findNavPage("/dashboard/free-provider-rankings")?.label, "Providers › Rankings");
  assert.equal(
    findNavPage("/optimize/token-saver/engines/caveman?tab=rules")?.pageLabel,
    "Caveman"
  );
  assert.equal(findNavPage("/optimize/token-saver/engines/caveman#rules")?.pageLabel, "Caveman");
  assert.equal(findNavPage("/dashboard/settings/security")?.pageLabel, "Security");
  assert.equal(findNavPage("/proxy/providers/fixture")?.entryId, "providers");
  assert.equal(findNavPage("/dashboard/providers-fake"), null);
});
test("live UI consumers no longer use the legacy page registry", () => {
  for (const file of ["CommandPalette", "Header", "Breadcrumbs", "Sidebar"]) {
    const source = readFileSync(`src/shared/components/${file}.tsx`, "utf8");
    assert.equal(source.includes("SIDEBAR_SECTIONS"), false, file);
    assert.equal(source.includes("sidebarNav"), true, file);
  }
});

test("network access has a direct System destination and prompts have one searchable home", () => {
  const network = findNavPage("/system/network");
  assert.equal(network?.entryId, "network");
  assert.equal(network?.pageLabel, "Network");
  assert.equal(canonicalDashboardPath("/system/network"), "/dashboard/settings/network");
  assert.equal(areaUrl("/dashboard/settings/network"), "/system/network");
  assert.equal(findNavPage("/system/settings/prompts")?.pageLabel, "Prompts");
  const items = getNavSearchItems();
  assert.equal(items.filter((item) => item.id === "settings-network").length, 1);
  assert.equal(items.filter((item) => item.id === "settings-prompts").length, 1);
});
