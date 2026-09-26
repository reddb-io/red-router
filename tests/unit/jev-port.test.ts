// Unit tests for the JEV decision-engine port (open-sse/decision/*.ts) — pure
// functions only, no network. Ported from the legacy fork's test expectations
// (tests/unit/decision-signals.test.js @ c66f917c) plus coverage for every pure
// helper the port exposes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseClassificationHint,
  hintTier,
  hintEffort,
  hintDeliberation,
  decisionOptOut,
  hintDetail,
} from "../../open-sse/decision/clientHint.ts";
import {
  extractSignals,
  detectFeedback,
  detectFrustration,
} from "../../open-sse/decision/signals.ts";
import {
  buildState,
  stripHarnessNoise,
  truncate,
  hasCacheBreakpoint,
  turnsOf,
} from "../../open-sse/decision/state.ts";
import {
  decideStrength,
  decideSwitch,
  rankByCost,
  winnerStrength,
  cheapestWithinBand,
  resolveToolDecision,
} from "../../open-sse/decision/decide.ts";
import {
  applyToolChoice,
  extractTools,
  hasPinnedToolChoice,
  supportsToolChoice,
} from "../../open-sse/decision/tools.ts";
import { injectHint, hintText } from "../../open-sse/decision/injectHint.ts";
import {
  normalizeAutopilotConfig,
  autopilotApplies,
  levelFromDeliberation,
  parseReasoningHeader,
  decideReasoningLevel,
} from "../../open-sse/decision/reasoningAutopilot.ts";
import { localDeliberation, tierForScore } from "../../open-sse/decision/localScorer.ts";
import {
  buildToolQuestions,
  buildModelQuestions,
  shortlistTools,
} from "../../open-sse/decision/questions.ts";

const reminder = (text) => `<system-reminder>${text}</system-reminder>`;

// ── clientHint.parseClassificationHint ────────────────────────────────────────

describe("parseClassificationHint", () => {
  it("parses a full hint", () => {
    const hint = parseClassificationHint(
      "complexity=0.5; needs_tool=true; tier=complex; effort=high"
    );
    assert.ok(hint);
    assert.equal(hint.complexity, 0.5);
    assert.equal(hint.needsTool, true);
    assert.equal(hint.tier, "COMPLEX");
    assert.equal(hint.effort, "high");
  });

  it("accepts decimal units with leading dot and trailing separator", () => {
    const hint = parseClassificationHint("deliberation=.5;frustration=1.000000;");
    assert.equal(hint.deliberation, 0.5);
    assert.equal(hint.frustration, 1);
  });

  it("maps a complexity label to its band middle", () => {
    assert.equal(parseClassificationHint("complexity=simple").complexity, 0.125);
    assert.equal(parseClassificationHint("complexity=reasoning").complexity, 0.875);
  });

  it("drops the whole header on a malformed pair", () => {
    const reasons = [];
    assert.equal(parseClassificationHint("complexity=0.5;;foo", { onInvalid: (r) => r }), null);
    assert.equal(parseClassificationHint("complexity", { onInvalid: (r) => r }), null);
    assert.equal(parseClassificationHint("needs_tool=maybe", { onInvalid: (r) => r }), null);
    assert.equal(
      parseClassificationHint("complexity=0.5;complexity=0.6", { onInvalid: (r) => r }),
      null
    );
    const hint = parseClassificationHint("=oops", { onInvalid: (r) => void reasons.push(r) });
    assert.equal(hint, null);
    assert.ok(reasons[0].startsWith("malformed_pair"));
  });

  it("skips unknown keys and rejects no-known-key hints", () => {
    assert.deepEqual(parseClassificationHint("foo=bar;stall=true"), { stall: true });
    assert.equal(parseClassificationHint("foo=bar"), null);
  });

  it("rejects out-of-range units, oversize values and non-strings", () => {
    assert.equal(parseClassificationHint("frustration=1.5"), null);
    assert.equal(parseClassificationHint("x".repeat(513) + "=1"), null);
    assert.equal(parseClassificationHint(42), null);
    assert.equal(parseClassificationHint(null), null);
  });
});

describe("hint accessors", () => {
  it("hintTier: explicit tier wins, complexity falls in bands", () => {
    assert.equal(hintTier({ tier: "REASONING" }), "REASONING");
    assert.equal(hintTier({ complexity: 0.3 }), "MEDIUM");
    assert.equal(hintTier({ complexity: 0.9 }), "REASONING");
    assert.equal(hintTier({}), null);
    assert.equal(hintTier(null), null);
  });

  it("hintEffort / hintDeliberation", () => {
    assert.equal(hintEffort({ effort: "low" }), "low");
    assert.equal(hintEffort({}), null);
    assert.equal(hintDeliberation({ deliberation: 0.5 }), 0.5);
    assert.equal(hintDeliberation(null), null);
  });

  it("decisionOptOut: off stops tools; model decision survives a stated deliberation", () => {
    assert.deepEqual(decisionOptOut("off", { deliberation: 0.5 }), { tools: true, model: false });
    assert.deepEqual(decisionOptOut("off", null), { tools: true, model: true });
    assert.deepEqual(decisionOptOut(" OFF ", null), { tools: true, model: true });
    assert.deepEqual(decisionOptOut(null, null), { tools: false, model: false });
  });

  it("hintDetail records the hint with source and used_for", () => {
    const detail = hintDetail({ complexity: 0.5, needsTool: true }, ["tool"]);
    assert.equal(detail.source, "client_hint");
    assert.equal(detail.tier, "COMPLEX");
    assert.deepEqual(detail.used_for, ["tool"]);
    assert.equal(hintDetail(null), null);
  });
});

// ── signals.extractSignals ────────────────────────────────────────────────────

describe("extractSignals", () => {
  it("reads stall from repeated tool calls in the recent window", () => {
    const messages = [{ role: "user", content: "fix the failing test" }];
    for (let i = 0; i < 3; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "npm test" } }],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: false, content: "ok" }],
      });
    }
    const signals = extractSignals({ messages });
    assert.equal(signals.stall, true);
    assert.equal(signals.turnKind, "tool_continuation");
  });

  it("no stall below the threshold", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] },
    ];
    assert.equal(extractSignals({ messages }).stall, false);
  });

  it("detects housekeeping sentinels and last tool error", () => {
    const housekeeping = extractSignals({
      messages: [
        { role: "user", content: "You are coming up with a succinct title for this chat" },
      ],
    });
    assert.equal(housekeeping.housekeeping, true);

    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t0", is_error: true, content: "boom" }],
      },
    ];
    assert.equal(extractSignals({ messages }).lastToolError, true);
  });

  it("a hint replaces transcript-derived stall/feedback/frustration", () => {
    const signals = extractSignals(
      { messages: [{ role: "user", content: "hello" }] },
      { hint: { stall: true, feedback: "agrees", frustration: 0.8 } }
    );
    assert.equal(signals.stall, true);
    assert.equal(signals.userFeedback, "agrees");
    assert.equal(signals.frustration, 0.8);
  });

  it("feedback: corrections win over agreement, agreement anchors at the start", () => {
    assert.equal(detectFeedback("perfeito, pode seguir"), "agrees");
    assert.equal(detectFeedback("perfeito, mas ainda está quebrado"), "corrects");
    assert.equal(detectFeedback("não era isso que eu pedi"), "rejects");
    assert.equal(detectFeedback("this is wrong"), "rejects");
    assert.equal(detectFeedback("what i meant was the other file"), "corrects");
    assert.equal(detectFeedback("the weather is nice"), null);
  });

  it("frustration: markers sum, prose only, capped at 1", () => {
    assert.equal(detectFrustration("wtf, de novo?!"), 0.9);
    assert.equal(detectFrustration("calm message"), 0);
    assert.equal(detectFrustration("```\nwtf\n```"), 0);
    assert.equal(detectFrustration(""), 0);
    assert.ok(detectFrustration("WTF WTF WTF") <= 1);
  });

  it("counts tools, tool calls, media and context tokens", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] },
      ],
      tools: [{ type: "function", function: { name: "Bash" } }],
    };
    const signals = extractSignals(body);
    assert.equal(signals.toolCount, 1);
    assert.equal(signals.hasMedia, true);
    assert.ok(signals.contextTokens > 0);
    assert.equal(signals.planMode, false);
  });

  it("plan mode sentinel lands through trailing reminder text", () => {
    const body = {
      messages: [{ role: "user", content: `${reminder("Plan mode is active")}\nwrite tests` }],
    };
    assert.equal(extractSignals(body).planMode, true);
  });

  it("local scorer reads the signals it was given", () => {
    const hard = localDeliberation({ explicitThink: true, planMode: true });
    assert.ok(hard.score > 0.8);
    const easy = localDeliberation({
      humanText: "rename this variable",
      turnKind: "tool_continuation",
    });
    assert.ok(easy.score < 0.3);
    assert.deepEqual(localDeliberation({ housekeeping: true }), {
      score: 0,
      reasons: ["housekeeping"],
    });
    assert.equal(tierForScore(0.1), "SIMPLE");
    assert.equal(tierForScore(0.5), "COMPLEX");
    assert.equal(tierForScore(0.9), "REASONING");
  });
});
// ── decide.decideStrength / rankByCost ────────────────────────────────────────

describe("decideStrength", () => {
  it("abstains without a verdict or a weak favourite", () => {
    assert.deepEqual(decideStrength({ strength: 0.9, verdict: null }), {
      change: false,
      reason: "no_verdict",
    });
    assert.deepEqual(decideStrength({ strength: 0.1, verdict: "a" }), {
      change: false,
      reason: "no_favourite",
    });
  });

  it("clear above the switch strength, confirmed by agreement", () => {
    assert.deepEqual(decideStrength({ strength: 0.7, verdict: "a" }), {
      change: true,
      reason: "clear",
    });
    assert.deepEqual(decideStrength({ strength: 0.4, verdict: "a", previousVerdict: "a" }), {
      change: true,
      reason: "confirmed",
    });
    assert.deepEqual(decideStrength({ strength: 0.4, verdict: "a", previousVerdict: "b" }), {
      change: false,
      reason: "awaiting_confirmation",
    });
  });

  it("decideSwitch keeps the legacy confidence gate semantics", () => {
    assert.deepEqual(decideSwitch({ confidence: 0.9, verdict: "a" }), {
      change: true,
      reason: "clear",
    });
    assert.deepEqual(decideSwitch({ confidence: 0.5, verdict: "a" }), {
      change: false,
      reason: "low_confidence",
    });
  });
});

describe("rankByCost", () => {
  it("orders cheapest first, keeps pool order on ties, unpriced last", () => {
    const pool = ["a", "b", "c", "d"];
    const priceOf = (m) => ({ a: 3, b: 1, c: 1, d: null })[m];
    assert.deepEqual(rankByCost(pool, priceOf), ["b", "c", "a", "d"]);
  });
});

describe("winnerStrength / cheapestWithinBand", () => {
  it("removes the option count from the winner's share", () => {
    assert.equal(winnerStrength({ probabilities: { a: 0.9, b: 0.1 } }), 0.8);
    assert.equal(winnerStrength({ probabilities: {} }), 0);
    assert.equal(winnerStrength({ probabilities: { a: 0.5 } }), 1);
  });

  it("tie-break moves to the cheapest within band, never past the verdict", () => {
    const priceOf = (m) => ({ a: 5, b: 2, c: 9 })[m];
    assert.equal(cheapestWithinBand("a", { a: 0.5, b: 0.45, c: 0.1 }, priceOf), "b");
    assert.equal(cheapestWithinBand("a", { a: 0.9, b: 0.45 }, priceOf), "a");
    const unknownPrice = () => null;
    assert.equal(cheapestWithinBand("a", { a: 0.5, b: 0.45 }, unknownPrice), "a");
  });
});

describe("resolveToolDecision", () => {
  const answers = (choice, confidence, noul) => ({
    tool: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
    needs_tool: { type: "noul", noul },
  });

  it("passthrough on rosters it cannot judge", () => {
    assert.equal(
      resolveToolDecision({ answers: answers("Bash", 0.9, 0.9), tools: [] }).reason,
      "no_tools"
    );
    assert.equal(
      resolveToolDecision({ answers: answers("Bash", 0.9, 0.9), tools: Array(121).fill("t") })
        .reason,
      "roster_too_large"
    );
    assert.equal(
      resolveToolDecision({ answers: answers("bad name!", 0.9, 0.9), tools: ["bad name!"] }).reason,
      "unsafe_tool_name"
    );
    assert.equal(
      resolveToolDecision({ answers: answers("a", 0.9, 0.9), tools: ["a", "a"] }).reason,
      "duplicate_tool_names"
    );
  });

  it("forces a tool when both questions agree and confidence clears the gate", () => {
    const d = resolveToolDecision({ answers: answers("Bash", 0.9, 0.9), tools: ["Bash", "Read"] });
    assert.deepEqual(d, { mode: "forced", tool: "Bash", confidence: 0.9 });
  });

  it("pins none when the pick is no_tool_needed and the gates agree", () => {
    const d = resolveToolDecision({
      answers: answers("no_tool_needed", 0.9, 0.1),
      tools: ["Bash"],
    });
    assert.equal(d.mode, "none");
  });

  it("signals_disagree when the two questions contradict", () => {
    assert.equal(
      resolveToolDecision({ answers: answers("Bash", 0.9, 0.1), tools: ["Bash"] }).reason,
      "signals_disagree"
    );
    assert.equal(
      resolveToolDecision({ answers: answers("no_tool_needed", 0.9, 0.8), tools: ["Bash"] }).reason,
      "signals_disagree"
    );
  });

  it("extended thinking caps the verdict at a hint", () => {
    const d = resolveToolDecision({
      answers: answers("Bash", 0.9, 0.9),
      tools: ["Bash"],
      extendedThinking: true,
    });
    assert.equal(d.mode, "hint");
    assert.equal(d.tool, "Bash");
  });
});

// ── state.buildState ──────────────────────────────────────────────────────────

describe("buildState", () => {
  it("strips harness blocks from turns and can drop the system prompt", () => {
    const body = {
      system: "You are Claude Code, a very long harness prompt",
      messages: [{ role: "user", content: `refactor auth\n${reminder("plan mode is off")}` }],
    };
    const state = buildState(body, { dropSystem: true });
    assert.equal(state.assistant_instructions, undefined);
    assert.deepEqual(state.conversation, [{ role: "user", text: "refactor auth" }]);
    assert.ok(buildState(body).assistant_instructions.includes("Claude Code"));
  });

  it("newest turns survive a spent budget and reports omissions", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `turn ${i}` }));
    const state = buildState({ messages }, { maxStateChars: 200, maxMessageChars: 50 });
    assert.ok(state.earlier_turns_omitted > 0);
    assert.ok(state.conversation[state.conversation.length - 1].text.includes("turn 39"));
  });

  it("maps tool/function roles to tool_result and truncates them", () => {
    const long = "x".repeat(2000);
    const body = { messages: [{ role: "tool", content: long }] };
    const state = buildState(body);
    assert.equal(state.conversation[0].role, "tool_result");
    assert.ok(state.conversation[0].text.length <= 600 + 20);
  });

  it("unknown shapes degrade to a truncated JSON picture", () => {
    const state = buildState({ weird: true }, { maxStateChars: 50 });
    assert.ok(typeof state.request === "string");
  });

  it("turnsOf reads every known message shape", () => {
    assert.deepEqual(turnsOf({ messages: [1] }), [1]);
    assert.deepEqual(turnsOf({ input: [2] }), [2]);
    assert.deepEqual(turnsOf({ contents: [3] }), [3]);
    assert.deepEqual(turnsOf({ conversation: { messages: [4] } }), [4]);
    assert.equal(turnsOf({}), null);
  });

  it("hasCacheBreakpoint finds explicit breakpoints on system, tools and turns", () => {
    assert.equal(hasCacheBreakpoint({ cache_control: {} }), true);
    assert.equal(hasCacheBreakpoint({ system: [{ cache_control: {} }] }), true);
    assert.equal(hasCacheBreakpoint({ tools: [{ cache_control: {} }] }), true);
    assert.equal(hasCacheBreakpoint({ messages: [{ role: "user", content: "hi" }] }), false);
  });

  it("stripHarnessNoise removes every known harness block shape", () => {
    assert.equal(
      stripHarnessNoise(
        `keep\n<system-reminder>x</system-reminder>\n<user_instructions>y</user_instructions>`
      ),
      "keep"
    );
  });

  it("text-only state helpers never return non-string values", () => {
    assert.equal(stripHarnessNoise({ noise: true }), "");
    assert.equal(truncate({ noise: true }, 10), "");
    assert.equal(truncate("long text", 4), " …[truncated]… ");
  });
});

// ── tools.applyToolChoice / extractTools ──────────────────────────────────────

describe("applyToolChoice", () => {
  it("writes format-native none/forced tool_choice", () => {
    const openai = { tool_choice: "auto" };
    assert.equal(applyToolChoice(openai, "openai", { mode: "none" }), true);
    assert.equal(openai.tool_choice, "none");
    const claude = { tool_choice: "auto" };
    applyToolChoice(claude, "claude", { mode: "none" });
    assert.deepEqual(claude.tool_choice, { type: "none" });
    const forced = {};
    applyToolChoice(forced, "openai", { mode: "forced", tool: "Bash" });
    assert.deepEqual(forced.tool_choice, { type: "function", function: { name: "Bash" } });
    const claudeForced = {};
    applyToolChoice(claudeForced, "claude", { mode: "forced", tool: "Bash" });
    assert.deepEqual(claudeForced.tool_choice, { type: "tool", name: "Bash" });
    const responsesForced = {};
    applyToolChoice(responsesForced, "openai-responses", { mode: "forced", tool: "Bash" });
    assert.deepEqual(responsesForced.tool_choice, { type: "function", name: "Bash" });
  });

  it("never overrides a caller's explicit pin or prohibition", () => {
    assert.equal(
      applyToolChoice({ tool_choice: { type: "any" } }, "openai", { mode: "none" }),
      false
    );
    assert.equal(applyToolChoice({ tool_choice: "auto" }, "openai", { mode: "none" }), true);
    assert.equal(applyToolChoice({ tool_choice: null }, "openai", { mode: "none" }), true);
    assert.equal(hasPinnedToolChoice({ tool_choice: "auto" }, "openai"), false);
    assert.equal(hasPinnedToolChoice({ tool_choice: { type: "auto" } }, "openai"), false);
    assert.equal(hasPinnedToolChoice({}, "openai"), false);
  });
});

describe("extractTools", () => {
  it("reads OpenAI, Claude and Gemini roster shapes", () => {
    const openai = { tools: [{ function: { name: "Bash", description: "run" } }] };
    assert.deepEqual(extractTools(openai, "openai"), [
      { name: "Bash", description: "run", kind: "function" },
    ]);
    const claude = { tools: [{ type: "web_search_20250305", name: "web_search" }] };
    const claudeTools = extractTools(claude, "claude");
    assert.equal(claudeTools[0].kind, "hosted");
    const gemini = { tools: [{ functionDeclarations: [{ name: "Bash" }] }] };
    assert.deepEqual(extractTools(gemini, "gemini"), [
      { name: "Bash", description: undefined, kind: "function" },
    ]);
    const antigravity = { tools: [{ functionDeclarations: [{ name: "Bash" }] }] };
    assert.equal(extractTools(antigravity, "antigravity").length, 1);
    assert.deepEqual(extractTools(null, "openai"), []);
  });

  it("supportsToolChoice covers the wire formats that accept tool_choice", () => {
    assert.equal(supportsToolChoice("openai"), true);
    assert.equal(supportsToolChoice("claude"), true);
    assert.equal(supportsToolChoice("openai-responses"), true);
    assert.equal(supportsToolChoice("ollama"), true);
    assert.equal(supportsToolChoice("gemini"), false);
  });
});

// ── injectHint ────────────────────────────────────────────────────────────────

describe("injectHint", () => {
  it("appends the hint to the last user turn without rewriting the prefix", () => {
    const body = { messages: [{ role: "user", content: "fix it" }] };
    assert.equal(injectHint(body, "openai", "Bash"), true);
    assert.equal(body.messages[0].content.length, 2);
    assert.ok(body.messages[0].content[1].text.includes("Bash"));
    // Idempotent: a second injection is a no-op.
    assert.equal(injectHint(body, "openai", "Bash"), false);
  });

  it("string contents are upgraded to a two-block array", () => {
    const body = { messages: [{ role: "user", content: "fix it" }] };
    injectHint(body, "openai", "Bash");
    assert.equal(body.messages[0].content[0].text, "fix it");
  });

  it("Responses and Gemini shapes get the native part types", () => {
    const responses = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    injectHint(responses, "openai-responses", "Bash");
    assert.equal(responses.input[0].content[1].type, "input_text");
    const gemini = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    injectHint(gemini, "gemini", "Bash");
    assert.ok(gemini.contents[0].parts[1].text.includes("Bash"));
    const antigravity = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    assert.equal(injectHint(antigravity, "antigravity", "Bash"), true);
  });

  it("fails open on unsafe names and empty content", () => {
    assert.equal(
      injectHint({ messages: [{ role: "user", content: "x" }] }, "openai", "bad name!"),
      false
    );
    assert.equal(
      injectHint({ messages: [{ role: "user", content: "" }] }, "openai", "Bash"),
      false
    );
    assert.equal(hintText(null), null);
    assert.equal(typeof hintText("Bash"), "string");
  });
});

// ── reasoningAutopilot.normalizeAutopilotConfig ───────────────────────────────

describe("normalizeAutopilotConfig", () => {
  it("fills defaults and coerces flag fields", () => {
    const config = normalizeAutopilotConfig(null);
    assert.equal(config.mode, "off");
    assert.equal(config.floor, "low");
    assert.equal(config.ceiling, "high");
    assert.equal(config.all, false);
    assert.equal(config.askJevDirect, true);
    assert.equal(config.minDwellTurns, 2);
    assert.deepEqual(config.apiKeys, []);
    assert.deepEqual(config.combos, []);
  });

  it("rejects unknown modes and merges an inverted floor into the ceiling", () => {
    assert.equal(normalizeAutopilotConfig({ mode: "yolo" }).mode, "off");
    // Legacy semantics: an inverted floor collapses onto the ceiling, it is not swapped.
    const inverted = normalizeAutopilotConfig({ floor: "high", ceiling: "low" });
    assert.equal(inverted.floor, "low");
    assert.equal(inverted.ceiling, "low");
    const badLevels = normalizeAutopilotConfig({ floor: "ultra", ceiling: "infinity" });
    assert.equal(badLevels.floor, "low");
    assert.equal(badLevels.ceiling, "high");
  });

  it("clamps numeric fields back to defaults", () => {
    assert.equal(normalizeAutopilotConfig({ minDwellTurns: -1 }).minDwellTurns, 2);
    assert.equal(normalizeAutopilotConfig({ timeoutMs: "soon" }).timeoutMs, 1200);
    assert.equal(normalizeAutopilotConfig({ contextFraction: 2 }).contextFraction, 0.5);
    assert.equal(normalizeAutopilotConfig({ all: "yes" }).all, false);
  });

  it("autopilotApplies honours mode, all, apiKeys and combos", () => {
    const config = normalizeAutopilotConfig({
      mode: "enforce",
      apiKeys: ["k1"],
      combos: ["smart"],
    });
    assert.equal(autopilotApplies(config, { apiKeyId: "k1" }), true);
    assert.equal(autopilotApplies(config, { comboName: "smart" }), true);
    assert.equal(autopilotApplies(config, { apiKeyId: "other" }), false);
    assert.equal(autopilotApplies(config, {}), false);
    assert.equal(autopilotApplies(config, { apiKeyId: "other" }), false);
    const allMode = normalizeAutopilotConfig({ mode: "shadow", all: true });
    assert.equal(autopilotApplies(allMode, {}), true);
    assert.equal(autopilotApplies(normalizeAutopilotConfig(null), {}), false);
  });

  it("levelFromDeliberation maps the 0..1 deliberation onto the ladder", () => {
    assert.equal(levelFromDeliberation(0.0), "minimal");
    assert.equal(levelFromDeliberation(0.2), "low");
    assert.equal(levelFromDeliberation(0.5), "medium");
    assert.equal(levelFromDeliberation(0.7), "high");
    assert.equal(levelFromDeliberation(0.9), "xhigh");
    assert.equal(levelFromDeliberation(null), null);
  });

  it("parseReasoningHeader accepts off/auto/levels and nothing else", () => {
    assert.deepEqual(parseReasoningHeader("off"), { mode: "off" });
    assert.deepEqual(parseReasoningHeader("AUTO"), { mode: "auto" });
    assert.deepEqual(parseReasoningHeader("high"), { mode: "force", level: "high" });
    assert.equal(parseReasoningHeader("banana"), null);
    assert.equal(parseReasoningHeader(7), null);
  });

  it("decideReasoningLevel: housekeeping is free, jev measurement lands on the ladder", () => {
    const free = decideReasoningLevel({ signals: { housekeeping: true }, previous: null });
    assert.deepEqual(free, {
      level: "none",
      cause: "housekeeping",
      from: null,
      base: "none",
      state: null,
    });

    const measured = decideReasoningLevel({
      signals: {},
      deliberation: 0.9,
      config: normalizeAutopilotConfig({}),
    });
    assert.ok(["high", "xhigh"].includes(measured.level));

    const kept = decideReasoningLevel({
      signals: {},
      jevFailed: true,
      previous: { level: "medium", changedAt: 0, turn: 1 },
      config: normalizeAutopilotConfig({}),
    });
    assert.equal(kept.level, "medium");
    assert.equal(kept.cause, "kept");
  });
});

// ── questions builders (sanity: one shape, no exception) ──────────────────────

describe("buildToolQuestions / buildModelQuestions", () => {
  it("every builder returns { questions }", () => {
    const tool = buildToolQuestions([{ name: "Bash", description: "run it" }]);
    assert.ok(tool.questions.tool && tool.questions.needs_tool);
    assert.ok(tool.questions.tool.criteria.no_tool_needed);
    const model = buildModelQuestions(["m1"], () => "does things");
    assert.ok(model.questions.model && model.questions.needs_reasoning);
    const noDeliberation = buildModelQuestions(["m1"], () => "x", { deliberation: false });
    assert.equal(noDeliberation.questions.needs_reasoning, undefined);
  });

  it("shortlistTools keeps used tools and lexical overlap, bounded", () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      description: `does thing number ${i}`,
    }));
    tools[7].description = "fix the login bug";
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "tool_0" } }] },
        { role: "user", content: "please fix the login bug" },
      ],
    };
    const short = shortlistTools(tools, body, 10);
    assert.equal(short.length, 10);
    assert.ok(short.some((t) => t.name === "tool_0"));
    assert.ok(short.some((t) => t.name === "tool_7"));
    assert.equal(shortlistTools(tools.slice(0, 5), body, 10).length, 5);
  });
});
