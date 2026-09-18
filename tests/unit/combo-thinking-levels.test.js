import { describe, expect, it } from "vitest";
import {
  comboThinkingLevels,
  resolveComboRequest,
  withThinkingSuffix,
} from "../../open-sse/services/combo.js";
import { getThinkingLevelsForId } from "../../open-sse/providers/thinkingLevels.js";

const COMBOS = [{ name: "fast", models: ["codex/gpt-5.6-sol", "codebuddy-cn/glm-5.3"] }];

describe("resolveComboRequest", () => {
  it("resolves an exact combo name without a suffix", () => {
    expect(resolveComboRequest("fast", COMBOS)).toEqual({
      models: COMBOS[0].models,
      comboName: "fast",
      suffix: "",
    });
  });

  it("parses a thinking suffix and re-attaches it to every member", () => {
    const resolved = resolveComboRequest("fast(high)", COMBOS);
    expect(resolved.comboName).toBe("fast");
    expect(resolved.suffix).toBe("(high)");
    expect(resolved.models).toEqual(["codex/gpt-5.6-sol(high)", "codebuddy-cn/glm-5.3(high)"]);
  });

  it("keeps a member's own thinking suffix over the combo-level one", () => {
    const data = [{ name: "own", models: ["glm-5.3(max)", "claude-opus-5"] }];
    expect(resolveComboRequest("own(low)", data).models).toEqual([
      "glm-5.3(max)",
      "claude-opus-5(low)",
    ]);
  });

  it("returns null for unknown combos and provider/model ids", () => {
    expect(resolveComboRequest("nope", COMBOS)).toBeNull();
    expect(resolveComboRequest("nope(high)", COMBOS)).toBeNull();
    expect(resolveComboRequest("codex/gpt-5.6-sol", COMBOS)).toBeNull();
  });
});

describe("comboThinkingLevels", () => {
  it("intersects the levels supported by every member", () => {
    const a = getThinkingLevelsForId("codex", "gpt-5.6-sol");
    const b = getThinkingLevelsForId("codebuddy-cn", "glm-5.3");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(comboThinkingLevels(COMBOS[0].models)).toEqual(a.filter((l) => b.includes(l)));
  });

  it("resolves members through their own thinking suffix", () => {
    expect(comboThinkingLevels(["codex/gpt-5.6-sol(high)"]))
      .toEqual(getThinkingLevelsForId("codex", "gpt-5.6-sol"));
  });

  it("returns null when any member cannot reason", () => {
    // kiro non-effort models have no thinking-level resolution at all
    expect(comboThinkingLevels(["codex/gpt-5.6-sol", "kiro/claude-sonnet-4.5"])).toBeNull();
  });

  it("returns null for empty or blank member lists", () => {
    expect(comboThinkingLevels([])).toBeNull();
    expect(comboThinkingLevels(["  "])).toBeNull();
  });
});

describe("withThinkingSuffix", () => {
  it("appends only to members without their own suffix", () => {
    expect(withThinkingSuffix(["glm-5.3(max)", "claude-opus-5"], "(low)"))
      .toEqual(["glm-5.3(max)", "claude-opus-5(low)"]);
  });
});

describe("getThinkingLevelsForId", () => {
  it("resolves a suffixed id through the clean model", () => {
    expect(getThinkingLevelsForId("codex", "gpt-5.6-sol(high)"))
      .toEqual(getThinkingLevelsForId("codex", "gpt-5.6-sol"));
  });

  it("returns null for a non-reasoning model", () => {
    expect(getThinkingLevelsForId("kiro", "claude-sonnet-4.5")).toBeNull();
  });
});
