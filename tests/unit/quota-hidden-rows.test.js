import { describe, expect, it } from "vitest";
import { getHiddenQuotaEntries, filterQuotasByVisibility } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("hidden quota rows can always be shown again", () => {
  const quotas = [{ name: "Weekly", modelKey: "weekly" }, { name: "Session" }];
  const visibility = { claude: { hidden: ["weekly", "Session", "renamed-row"] } };

  it("lists every saved hidden row, named when it is loaded and by key otherwise", () => {
    expect(getHiddenQuotaEntries("claude", quotas, visibility)).toEqual([
      { key: "weekly", name: "Weekly" },
      { key: "Session", name: "Session" },
      { key: "renamed-row", name: "renamed-row" },
    ]);
  });

  it("still lists them when the provider's quota failed to load", () => {
    expect(getHiddenQuotaEntries("claude", [], visibility).map((r) => r.key)).toEqual(["weekly", "Session", "renamed-row"]);
  });

  it("hides exactly the saved rows", () => {
    expect(filterQuotasByVisibility("claude", quotas, visibility)).toEqual([]);
    expect(filterQuotasByVisibility("claude", quotas, { claude: { hidden: [] } })).toEqual(quotas);
  });
});
