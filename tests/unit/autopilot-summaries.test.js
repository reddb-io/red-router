import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/runtime", () => ({ translate: (s) => s }));
const { decisionRouterSummary, reasoningAutopilotSummary } = await import("@/shared/utils/autopilotSummary.js");
const { getPageInfo } = await import("@/shared/utils/pageInfo.js");

describe("Autopilot says what it does in one sentence", () => {
  it("model choice", () => {
    expect(decisionRouterSummary({ mode: "off", models: [] })).toMatch(/^Off\. Combos serve requests in their own order/);
    expect(decisionRouterSummary({ mode: "enforce", models: [] })).toMatch(/nothing to pick from/);
    expect(decisionRouterSummary({ mode: "shadow", models: ["auto-coding"] })).toMatch(/^Test run on auto-coding: .*logs it/);
    expect(decisionRouterSummary({ mode: "enforce", models: ["a", "b", "c", "d", "e"] })).toMatch(/^On for a, b, c \+2: /);
  });

  it("reasoning", () => {
    const base = { floor: "low", ceiling: "high", apiKeys: [], combos: [] };
    expect(reasoningAutopilotSummary({ ...base, mode: "off" })).toMatch(/^Off\. Each request thinks as much as the client asked for/);
    expect(reasoningAutopilotSummary({ ...base, mode: "enforce", all: false })).toMatch(/Nothing chosen yet/);
    expect(reasoningAutopilotSummary({ ...base, mode: "enforce", all: true })).toMatch(/^On for every request: .*within low–high\.$/);
    expect(reasoningAutopilotSummary({ ...base, mode: "shadow", all: false, apiKeys: ["k1"], combos: ["c1", "c2"] })).toMatch(/^Test run on 1 API key and 2 combos: /);
  });

  it("has its own page in the navigation", () => {
    expect(getPageInfo("/dashboard/autopilot").title).toBe("Autopilot");
  });
});
