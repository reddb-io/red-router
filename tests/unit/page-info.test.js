import { describe, expect, it } from "vitest";
import { getPageInfo, hasOwnHeading } from "@/shared/utils/pageInfo.js";

describe("dashboard page identity", () => {
  it("lets detail pages keep their own heading and gives list pages the layout heading", () => {
    for (const path of [
      "/dashboard/setup",
      "/dashboard/providers/openai",
      "/dashboard/tools-providers/web/tavily",
      "/dashboard/cli-tools/claude",
      "/dashboard/keys/abc",
    ]) {
      expect(hasOwnHeading(path), path).toBe(true);
    }
    for (const path of [
      "/dashboard",
      "/dashboard/providers",
      "/dashboard/providers/new",
      "/dashboard/combos",
      "/dashboard/usage",
      "/dashboard/proxy-pools",
    ]) {
      expect(hasOwnHeading(path), path).toBe(false);
    }
  });

  it("carries the titles of pages whose own H1 moved into the layout heading", () => {
    expect(getPageInfo("/dashboard").title).toBe("Usage");
    expect(getPageInfo("/dashboard/usage").title).toBe("Usage");
    expect(getPageInfo("/dashboard/skills").title).toBe("Skills");
    expect(getPageInfo("/dashboard/translator").title).toBe("Translator Debug");
    expect(getPageInfo("/dashboard/proxy-pools").title).toBe("Proxy Pools");
    expect(getPageInfo("/dashboard/usage-sinks").title).toBe("Usage Sinks");
    const add = getPageInfo("/dashboard/providers/new");
    expect(add.title).toBe("Add New Provider");
    expect(add.breadcrumbs.map((c) => c.label)).toEqual(["Providers", "Add New Provider"]);
  });
});
