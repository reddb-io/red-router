import { describe, it, expect } from "vitest";
import { planReasoning, resetReasoningSessions } from "../../src/sse/services/decisionRouter.js";
import {
  autopilotApplies,
  decideReasoningLevel,
  levelFromDeliberation,
  normalizeAutopilotConfig,
  parseReasoningHeader,
  REASONING_HEADER_VALUES,
} from "../../open-sse/decision/reasoningAutopilot.js";
import { parseClassificationHint } from "../../open-sse/decision/clientHint.js";
import { withRequestId } from "../../open-sse/utils/error.js";
import { REASONING_HEADER, REASONING_RESPONSE_HEADER } from "../../open-sse/config/runtimeConfig.js";

const config = normalizeAutopilotConfig({ mode: "enforce", floor: "minimal", ceiling: "xhigh", minDwellTurns: 2 });
const human = { turnKind: "human" };

describe("normalizeAutopilotConfig", () => {
  it("defaults to off with a low..high window", () => {
    expect(normalizeAutopilotConfig()).toMatchObject({ mode: "off", floor: "low", ceiling: "high", askJevDirect: true });
  });

  it("defaults the heavy-context step to half the window and repairs bad fractions", () => {
    expect(normalizeAutopilotConfig().contextFraction).toBe(0.5);
    expect(normalizeAutopilotConfig({ contextFraction: 0 }).contextFraction).toBe(0);
    expect(normalizeAutopilotConfig({ contextFraction: 1.5 }).contextFraction).toBe(0.5);
    expect(normalizeAutopilotConfig({ contextFraction: "x" }).contextFraction).toBe(0.5);
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

describe("decideReasoningLevel: human feedback and frustration", () => {
  it.each([
    [{ userFeedback: "rejects" }, "high", "feedback"],
    [{ userFeedback: "corrects" }, "high", "feedback"],
    [{ frustration: 0.6 }, "high", "frustration"],
    [{ frustration: 0.59 }, "medium", "jev"],
    [{ userFeedback: "neutral" }, "medium", "jev"],
    [{ userFeedback: "agrees" }, "low", "jev+agrees"],
    [{ userFeedback: "agrees", stall: true }, "high", "stall"],
    [{ userFeedback: "rejects", frustration: 0.9 }, "high", "feedback"],
  ])("%j at deliberation 0.5 → %s (%s)", (extra, level, cause) => {
    expect(decideReasoningLevel({ signals: { ...human, ...extra }, deliberation: 0.5, config })).toMatchObject({ level, cause });
  });

  it("raises at once on feedback or frustration, but lowers on agreement only after the dwell", () => {
    const start = decideReasoningLevel({ signals: human, deliberation: 0.5, turnId: "t1", config });
    const rejected = decideReasoningLevel({ signals: { ...human, userFeedback: "rejects" }, deliberation: 0.5, turnId: "t2", previous: start.state, config });
    expect(rejected).toMatchObject({ level: "high", cause: "feedback" });

    const agreed = decideReasoningLevel({ signals: { ...human, userFeedback: "agrees" }, deliberation: 0.5, turnId: "t3", previous: rejected.state, config });
    expect(agreed).toMatchObject({ level: "high", cause: "dwell" });
    const later = decideReasoningLevel({ signals: { ...human, userFeedback: "agrees" }, deliberation: 0.5, turnId: "t4", previous: agreed.state, config });
    expect(later).toMatchObject({ level: "low", cause: "jev+agrees" });
  });
});

describe("decideReasoningLevel: heavy context", () => {
  const signals = (contextTokens) => ({ ...human, contextTokens });
  it.each([
    [60_000, 100_000, "high", "context"],
    [50_000, 100_000, "medium", "jev"],
    [60_000, null, "medium", "jev"],
  ])("%i tokens in a %s window → %s", (tokens, window, level, cause) => {
    expect(decideReasoningLevel({ signals: signals(tokens), deliberation: 0.5, contextWindow: window, config })).toMatchObject({ level, cause });
  });

  it("never stacks on a trouble step, and can be disabled", () => {
    expect(decideReasoningLevel({ signals: { ...signals(90_000), stall: true }, deliberation: 0.5, contextWindow: 100_000, config }))
      .toMatchObject({ level: "high", cause: "stall" });
    expect(decideReasoningLevel({ signals: signals(90_000), deliberation: 0.5, contextWindow: 100_000, config: { ...config, contextFraction: 0 } }))
      .toMatchObject({ level: "medium" });
  });
});

describe("decideReasoningLevel: the level moves at the human boundary", () => {
  const first = decideReasoningLevel({ signals: human, deliberation: 0.5, turnId: "turn-a", config });

  it("records which human turn set the level", () => {
    expect(first.state).toMatchObject({ level: "medium", humanTurn: "turn-a", loopStep: false, turn: 1 });
  });

  it("holds through the turn's tool loop whatever jev or the signals would say", () => {
    const loop = { turnKind: "tool_continuation" };
    const held = decideReasoningLevel({ signals: loop, deliberation: 0.95, turnId: "turn-a", previous: first.state, config });
    expect(held).toMatchObject({ level: "medium", cause: "hold" });
    expect(held.state).toBe(first.state);
    expect(decideReasoningLevel({ signals: { ...loop, userFeedback: "rejects", planMode: true }, turnId: "turn-a", previous: first.state, config }))
      .toMatchObject({ level: "medium", cause: "hold" });
  });

  it("steps up once per human turn when the loop stalls or a tool fails", () => {
    const loop = { turnKind: "tool_continuation" };
    const stalled = decideReasoningLevel({ signals: { ...loop, stall: true }, turnId: "turn-a", previous: first.state, config });
    expect(stalled).toMatchObject({ level: "high", cause: "stall" });
    expect(stalled.state).toMatchObject({ level: "high", loopStep: true, humanTurn: "turn-a", turn: 1 });

    const again = decideReasoningLevel({ signals: { ...loop, lastToolError: true }, turnId: "turn-a", previous: stalled.state, config });
    expect(again).toMatchObject({ level: "high", cause: "hold" });

    const next = decideReasoningLevel({ signals: { ...human, lastToolError: true }, deliberation: 0.5, turnId: "turn-b", previous: again.state, config });
    expect(next).toMatchObject({ level: "high", cause: "tool_error" });
    expect(next.state).toMatchObject({ humanTurn: "turn-b", loopStep: false, turn: 2 });
  });

  it("does not step past the ceiling mid-loop", () => {
    const narrow = normalizeAutopilotConfig({ mode: "enforce", floor: "low", ceiling: "medium" });
    const top = decideReasoningLevel({ signals: human, deliberation: 0.9, turnId: "t", config: narrow });
    expect(decideReasoningLevel({ signals: { stall: true }, turnId: "t", previous: top.state, config: narrow }))
      .toMatchObject({ level: "medium", cause: "hold" });
  });

  it("keeps the previous level when jev fails, and falls back to the client without one", () => {
    const high = decideReasoningLevel({ signals: human, deliberation: 0.7, turnId: "t1", config });
    expect(decideReasoningLevel({ signals: { ...human, clientEffort: { mode: "level", level: "low" } }, jevFailed: true, turnId: "t2", previous: high.state, config }))
      .toMatchObject({ level: "high", cause: "kept", from: "low" });
    expect(decideReasoningLevel({ signals: { ...human, clientEffort: { mode: "level", level: "low" } }, jevFailed: true, turnId: "t1", config }))
      .toMatchObject({ level: "low", cause: "client" });
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

  it("accepts exactly the values capabilities advertises", () => {
    expect(REASONING_HEADER_VALUES).toEqual(["off", "auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const value of REASONING_HEADER_VALUES) expect(parseReasoningHeader(value)).not.toBeNull();
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

describe("planReasoning: the header and hint contract", () => {
  const body = { messages: [{ role: "user", content: "refactor the parser" }] };
  // Autopilot off and no key covered: only the request itself can opt in.
  const off = { reasoningAutopilot: { mode: "off", askJevDirect: false, floor: "minimal", ceiling: "xhigh" } };
  const headers = (value) => ({ [REASONING_HEADER]: value });

  it("runs the autopilot, enforced, for a request that sends auto", async () => {
    resetReasoningSessions();
    const plan = await planReasoning({ body, settings: off, sessionId: "auto-1", headers: headers("auto"), deliberation: 0.7 });
    expect(plan).toMatchObject({ mode: "enforce", level: "high", cause: "jev", target: { mode: "set", level: "high" } });
    expect(await planReasoning({ body, settings: off, sessionId: "auto-2", deliberation: 0.7 })).toBeNull();
  });

  it("enforces auto even where the configured mode is shadow, within floor and ceiling", async () => {
    resetReasoningSessions();
    const shadow = { reasoningAutopilot: { mode: "shadow", all: true, askJevDirect: false, floor: "low", ceiling: "medium" } };
    const plan = await planReasoning({ body, settings: shadow, sessionId: "auto-3", headers: headers("auto"), deliberation: 0.95 });
    expect(plan).toMatchObject({ mode: "enforce", level: "medium", target: { mode: "set", level: "medium" } });
  });

  it("maps a hinted effort like an explicit level, and an explicit header beats both", async () => {
    const hint = parseClassificationHint("effort=xhigh");
    expect(await planReasoning({ body, settings: off, headers: headers("auto"), hint }))
      .toMatchObject({ level: "xhigh", cause: "hint", target: { mode: "set", level: "xhigh" } });
    expect(await planReasoning({ body, settings: off, hint })).toMatchObject({ level: "xhigh", cause: "hint" });
    expect(await planReasoning({ body, settings: off, headers: headers("low"), hint })).toMatchObject({ level: "low", cause: "header" });
    expect(await planReasoning({ body, settings: off, headers: headers("off"), hint })).toBeNull();
  });

  it("lets hinted feedback, frustration and stall replace the transcript's reading", async () => {
    resetReasoningSessions();
    const hint = parseClassificationHint("feedback=rejects");
    expect(await planReasoning({ body, settings: off, sessionId: "fb", headers: headers("auto"), hint, deliberation: 0.5 }))
      .toMatchObject({ level: "high", cause: "feedback" });
    const calm = { messages: [{ role: "user", content: "wtf, still broken AGAIN!!!" }] };
    expect(await planReasoning({ body: calm, settings: off, sessionId: "fr", headers: headers("auto"), hint: parseClassificationHint("feedback=neutral;frustration=0"), deliberation: 0.5 }))
      .toMatchObject({ level: "medium", cause: "jev" });
  });

  it("holds the level through the human turn's tool loop, with one step up on a stall", async () => {
    resetReasoningSessions();
    const settings = { reasoningAutopilot: { mode: "enforce", all: true, askJevDirect: false, floor: "minimal", ceiling: "xhigh" } };
    const ask = { role: "user", content: "fix the failing test" };
    const loop = (errors) => ({
      messages: [ask, ...errors.flatMap((isError, i) => [
        { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "npm test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: isError, content: "exit 1" }, { type: "text", text: "<system-reminder>todo list</system-reminder>" }] },
      ])],
      tools: [{ name: "Bash" }],
    });
    const plan = (request, deliberation) => planReasoning({ body: request, settings, sessionId: "loop", deliberation });

    expect(await plan({ messages: [ask], tools: [{ name: "Bash" }] }, 0.5)).toMatchObject({ level: "medium", cause: "jev" });
    expect(await plan(loop([false]), 0.9)).toMatchObject({ level: "medium", cause: "hold" });
    expect(await plan(loop([false, true, true, true]), 0.9)).toMatchObject({ level: "high", cause: "stall" });
    expect(await plan(loop([false, true, true, true, true]), 0.9)).toMatchObject({ level: "high", cause: "hold" });
  });

  it("drops redcode's title calls to the minimum level", async () => {
    const title = {
      system: "You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title that would help the user find this conversation later.",
      messages: [{ role: "user", content: "debug 500 errors in production" }],
    };
    expect(await planReasoning({ body: title, settings: off, sessionId: "title", headers: headers("auto"), deliberation: 0.9 }))
      .toMatchObject({ level: "none", cause: "housekeeping", target: { mode: "set", level: "none" } });
  });

  it("reports the decision in X-RedRouter-Reasoning, marking shadow verdicts", async () => {
    const stamp = (reasoning) => withRequestId(new Response("{}", { status: 200 }), { requestId: "req-1" }, { reasoning }).headers.get(REASONING_RESPONSE_HEADER);
    expect(REASONING_RESPONSE_HEADER).toBe("X-RedRouter-Reasoning");
    expect(stamp({ level: "high", from: "low", cause: "feedback", target: { mode: "set", level: "high" } })).toBe("low->high; cause=feedback");
    expect(stamp({ level: "xhigh", from: null, cause: "hint", target: { mode: "set", level: "xhigh" } })).toBe("-->xhigh; cause=hint");
    expect(stamp({ level: "medium", from: null, cause: "jev", target: null })).toBe("-->medium; cause=jev; shadow");
  });
});
