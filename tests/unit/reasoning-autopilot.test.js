import { describe, it, expect } from "vitest";
import { planReasoning, resetReasoningSessions } from "../../src/sse/services/decisionRouter.js";
import {
  autopilotApplies,
  decideReasoningLevel,
  levelFromDeliberation,
  normalizeAutopilotConfig,
  parseReasoningHeader,
} from "../../open-sse/decision/reasoningAutopilot.js";

const config = normalizeAutopilotConfig({ mode: "enforce", floor: "minimal", ceiling: "xhigh", minDwellTurns: 2 });
const human = { turnKind: "human" };

describe("normalizeAutopilotConfig", () => {
  it("defaults to off with a low..high window", () => {
    expect(normalizeAutopilotConfig()).toMatchObject({ mode: "off", floor: "low", ceiling: "high", askJevDirect: true });
  });

  it("repairs invalid modes, levels and an inverted window", () => {
    expect(normalizeAutopilotConfig({ mode: "yolo", floor: "high", ceiling: "low", apiKeys: "x" }))
      .toMatchObject({ mode: "off", floor: "low", ceiling: "low", apiKeys: [] });
  });
});

describe("autopilotApplies", () => {
  const cfg = normalizeAutopilotConfig({ mode: "shadow", apiKeys: ["key-1"], combos: ["auto"] });
  it("covers opted-in keys and combos only", () => {
    expect(autopilotApplies(cfg, { apiKeyId: "key-1" })).toBe(true);
    expect(autopilotApplies(cfg, { comboName: "auto" })).toBe(true);
    expect(autopilotApplies(cfg, { apiKeyId: "key-2", comboName: "fast" })).toBe(false);
    expect(autopilotApplies({ ...cfg, all: true }, {})).toBe(true);
    expect(autopilotApplies({ ...cfg, mode: "off" }, { apiKeyId: "key-1" })).toBe(false);
  });
});

describe("levelFromDeliberation", () => {
  it("maps needs_reasoning bands onto the ladder", () => {
    expect(levelFromDeliberation(0.05)).toBe("minimal");
    expect(levelFromDeliberation(0.3)).toBe("low");
    expect(levelFromDeliberation(0.5)).toBe("medium");
    expect(levelFromDeliberation(0.7)).toBe("high");
    expect(levelFromDeliberation(0.95)).toBe("xhigh");
    expect(levelFromDeliberation(null)).toBeNull();
  });
});

describe("decideReasoningLevel", () => {
  it("raises for hard work and lowers for mechanical work", () => {
    expect(decideReasoningLevel({ signals: human, deliberation: 0.9, config })).toMatchObject({ level: "xhigh", cause: "jev" });
    expect(decideReasoningLevel({ signals: human, deliberation: 0.1, config })).toMatchObject({ level: "minimal", cause: "jev" });
  });

  it("falls back to the client's own effort, then medium, without jev", () => {
    expect(decideReasoningLevel({ signals: { ...human, clientEffort: { mode: "level", level: "high" } }, config }))
      .toMatchObject({ level: "high", cause: "client", from: "high" });
    expect(decideReasoningLevel({ signals: { ...human, clientEffort: { mode: "budget", budget: 2000 } }, config }))
      .toMatchObject({ level: "low", from: "low" });
    expect(decideReasoningLevel({ signals: human, config })).toMatchObject({ level: "medium", cause: "default" });
  });

  it("drops to none for housekeeping and leaves session state alone", () => {
    const previous = { level: "high", changedAt: 3, turn: 5 };
    const result = decideReasoningLevel({ signals: { housekeeping: true }, deliberation: 0.9, previous, config });
    expect(result).toMatchObject({ level: "none", cause: "housekeeping" });
    expect(result.state).toBe(previous);
  });

  it("steps up on a stall or tool error and floors plan mode / explicit think at high", () => {
    expect(decideReasoningLevel({ signals: { ...human, stall: true }, deliberation: 0.5, config })).toMatchObject({ level: "high", cause: "stall" });
    expect(decideReasoningLevel({ signals: { ...human, lastToolError: true }, deliberation: 0.5, config })).toMatchObject({ level: "high", cause: "tool_error" });
    expect(decideReasoningLevel({ signals: { ...human, planMode: true }, deliberation: 0.1, config })).toMatchObject({ level: "high", cause: "plan_mode" });
    expect(decideReasoningLevel({ signals: { ...human, explicitThink: true }, deliberation: 0.1, config })).toMatchObject({ level: "high", cause: "explicit_think" });
  });

  it("goes one notch lower on a healthy tool continuation", () => {
    expect(decideReasoningLevel({ signals: { turnKind: "tool_continuation" }, deliberation: 0.5, config }))
      .toMatchObject({ level: "low", cause: "jev+continuation" });
  });

  it("clamps to the configured floor and ceiling", () => {
    const narrow = normalizeAutopilotConfig({ mode: "enforce", floor: "low", ceiling: "medium" });
    expect(decideReasoningLevel({ signals: human, deliberation: 0.95, config: narrow }).level).toBe("medium");
    expect(decideReasoningLevel({ signals: human, deliberation: 0.01, config: narrow }).level).toBe("low");
  });

  it("holds a level for minDwellTurns before dropping, but rises at once on urgent causes", () => {
    const first = decideReasoningLevel({ signals: human, deliberation: 0.9, config });
    expect(first.state).toMatchObject({ level: "xhigh", changedAt: 1, turn: 1 });

    const held = decideReasoningLevel({ signals: human, deliberation: 0.1, previous: first.state, config });
    expect(held).toMatchObject({ level: "xhigh", cause: "dwell" });

    const dropped = decideReasoningLevel({ signals: human, deliberation: 0.1, previous: held.state, config });
    expect(dropped).toMatchObject({ level: "minimal", cause: "jev" });
    expect(dropped.state).toMatchObject({ level: "minimal", changedAt: 3 });

    const urgent = decideReasoningLevel({ signals: { ...human, stall: true }, deliberation: 0.1, previous: dropped.state, config });
    expect(urgent).toMatchObject({ level: "low", cause: "stall" });
  });
});

describe("parseReasoningHeader", () => {
  it("accepts off, auto and ladder levels", () => {
    expect(parseReasoningHeader("off")).toEqual({ mode: "off" });
    expect(parseReasoningHeader(" HIGH ")).toEqual({ mode: "force", level: "high" });
    expect(parseReasoningHeader("auto")).toEqual({ mode: "auto" });
    expect(parseReasoningHeader("turbo")).toBeNull();
    expect(parseReasoningHeader(undefined)).toBeNull();
  });
});

describe("planReasoning", () => {
  const settings = (extra = {}) => ({ reasoningAutopilot: { mode: "enforce", all: true, askJevDirect: false, floor: "minimal", ceiling: "xhigh", ...extra } });
  const body = { messages: [{ role: "user", content: "ultrathink: why does this deadlock?" }] };

  it("forces a level from the header, even with the autopilot off", async () => {
    const plan = await planReasoning({ body, settings: {}, headers: { "x-red-router-reasoning": "low" } });
    expect(plan).toMatchObject({ level: "low", cause: "header", target: { mode: "set", level: "low" } });
  });

  it("returns null when the header opts out or the request is not covered", async () => {
    expect(await planReasoning({ body, settings: settings(), headers: { "x-red-router-reasoning": "off" } })).toBeNull();
    expect(await planReasoning({ body, settings: settings({ all: false, apiKeys: ["k1"] }), apiKeyId: "k2" })).toBeNull();
  });

  it("uses a combo's measured deliberation plus signals, and only targets in enforce", async () => {
    resetReasoningSessions();
    const enforce = await planReasoning({ body, settings: settings(), sessionId: "s1", deliberation: 0.2 });
    expect(enforce).toMatchObject({ level: "high", cause: "explicit_think", target: { mode: "set", level: "high" } });

    const shadow = await planReasoning({ body, settings: settings({ mode: "shadow" }), sessionId: "s2", deliberation: 0.2 });
    expect(shadow).toMatchObject({ level: "high", target: null });
  });
});
