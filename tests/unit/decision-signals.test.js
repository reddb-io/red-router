import { describe, it, expect } from "vitest";
import { decideComboModel } from "../../src/sse/services/decisionRouter.js";
import { extractSignals, toolCallsOf, detectStall, signalsMeta, detectFeedback, detectFrustration } from "../../open-sse/decision/signals.js";
import { buildState, stripHarnessNoise } from "../../open-sse/decision/state.js";
import { resolveModelDecision } from "../../open-sse/decision/decide.js";

const reminder = (text) => `<system-reminder>${text}</system-reminder>`;

// Claude Code shaped turn: tool_use in the assistant turn, tool_result back in a user turn.
const ccToolLoop = (results) => {
  const messages = [{ role: "user", content: "fix the failing test" }];
  results.forEach((isError, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "npm test" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: isError, content: isError ? "exit 1" : "ok" }] });
  });
  return { model: "claude", messages, tools: [{ name: "Bash", input_schema: { type: "object" } }] };
};

describe("stripHarnessNoise", () => {
  it("removes system reminders and Codex context blocks", () => {
    const text = [
      "real ask",
      reminder("todo list is empty"),
      "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
      "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nbe terse\n</INSTRUCTIONS>",
    ].join("\n");
    expect(stripHarnessNoise(text)).toBe("real ask");
  });
});

describe("buildState hygiene", () => {
  it("strips harness blocks from turns and can drop the system prompt", () => {
    const body = {
      system: "You are Claude Code, a very long harness prompt",
      messages: [{ role: "user", content: `refactor auth\n${reminder("plan mode is off")}` }],
    };
    const state = buildState(body, { dropSystem: true });
    expect(state.assistant_instructions).toBeUndefined();
    expect(state.conversation).toEqual([{ role: "user", text: "refactor auth" }]);
    expect(buildState(body).assistant_instructions).toContain("Claude Code");
  });
});

describe("extractSignals", () => {
  it("flags title generation as housekeeping only when no tools are offered", () => {
    const body = {
      system: "You are coming up with a succinct title for a coding session.",
      messages: [{ role: "user", content: "long session transcript…" }],
    };
    expect(extractSignals(body).housekeeping).toBe(true);
    expect(extractSignals({ ...body, tools: [{ name: "Read" }] }).housekeeping).toBe(false);
  });

  it("detects plan mode from the reminder in the newest turn", () => {
    const body = { messages: [{ role: "user", content: `design the cache\n${reminder("Plan mode is active. Do not edit files.")}` }] };
    const signals = extractSignals(body);
    expect(signals.planMode).toBe(true);
    expect(signals.humanText).toBe("design the cache");
  });

  it("detects explicit think requests in the human text", () => {
    expect(extractSignals({ messages: [{ role: "user", content: "ultrathink about this race" }] }).explicitThink).toBe(true);
    expect(extractSignals({ messages: [{ role: "user", content: "pense bem antes de mudar" }] }).explicitThink).toBe(true);
    expect(extractSignals({ messages: [{ role: "user", content: "list files" }] }).explicitThink).toBe(false);
  });

  it("marks tool continuations, stalls and the last tool error (Claude shape)", () => {
    const stalled = extractSignals(ccToolLoop([true, true, true]));
    expect(stalled.turnKind).toBe("tool_continuation");
    expect(stalled.stall).toBe(true);
    expect(stalled.lastToolError).toBe(true);

    const healthy = extractSignals(ccToolLoop([false]));
    expect(healthy.stall).toBe(false);
    expect(healthy.lastToolError).toBe(false);
  });

  it("reads OpenAI and Responses tool shapes", () => {
    const openai = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ id: "a", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "a", content: "x" },
      ],
    };
    expect(toolCallsOf(openai)).toEqual([{ name: "ls", args: "{}", error: false }]);
    expect(extractSignals(openai).turnKind).toBe("tool_continuation");

    const responses = {
      input: [
        { role: "user", content: "go" },
        { type: "function_call", call_id: "c", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "c", output: "boom", status: "error" },
      ],
    };
    expect(toolCallsOf(responses)[0]).toMatchObject({ name: "shell", error: true });
  });

  it("counts repeated identical calls as a stall", () => {
    const call = { name: "Read", args: "{\"path\":\"a\"}", error: false };
    expect(detectStall([call, call, call])).toBe(true);
    expect(detectStall([call, { ...call, args: "{}" }, call])).toBe(false);
  });

  it("recognises harness user agents and keeps free text out of the meta", () => {
    const signals = extractSignals({ messages: [{ role: "user", content: "hi" }] }, { userAgent: "claude-cli/2.1.0 (external, cli)" });
    expect(signals.harnessSystem).toBe(true);
    expect(signalsMeta(signals)).not.toHaveProperty("humanText");
  });
});

describe("detectFeedback", () => {
  it.each([
    ["não era isso que eu pedi", "rejects"],
    ["Nao era isso", "rejects"],
    ["that's not what i asked for", "rejects"],
    ["That\u2019s wrong, revert it", "rejects"],
    ["de novo não, para com isso", "rejects"],
    ["no, i meant the other file", "corrects"],
    ["No I meant the parser", "corrects"],
    ["ainda está quebrado", "corrects"],
    ["ainda quebrado depois do fix", "corrects"],
    ["still broken after your change", "corrects"],
    ["like i said, use pnpm", "corrects"],
    ["como eu disse, sem mocks", "corrects"],
    ["perfeito, segue pro próximo", "agrees"],
    ["isso mesmo", "agrees"],
    ["ok, segue", "agrees"],
    ["Ótimo! agora os testes", "agrees"],
    ["great, now add the docs", "agrees"],
    ["Exactly.", "agrees"],
    ["lgtm", "agrees"],
    ["perfeito, mas ainda quebrado no CI", "corrects"],
    ["this is great but ship it tomorrow", null],
    ["segue o log do erro", null],
    ["show me the config", null],
    ["refactor the parser to stream", null],
    ["rename the `still broken` test to `flaky`", null],
    ["", null],
  ])("%j → %s", (text, expected) => {
    expect(detectFeedback(text)).toBe(expected);
  });
});

describe("detectFrustration", () => {
  it.each([
    ["refactor the parser", 0],
    ["run the tests again", 0.3],
    ["wtf", 0.4],
    ["why?!", 0.2],
    ["wtf, again?!", 0.9],
    ["PORRA, DE NOVO ESSE ERRO", 1],
    ["PARA DE MEXER NESSE ARQUIVO!!!", 0.6],
    ["how many times do I need to say this, fuck", 0.7],
    ["```\nERROR: FAILED TO CONNECT TO DATABASE AGAIN\n```\nwhat does this mean?", 0],
    ["OK", 0],
  ])("%j → %d", (text, expected) => {
    expect(detectFrustration(text)).toBe(expected);
  });
});

describe("extractSignals: feedback, frustration and the human turn", () => {
  it("reads feedback and frustration from the newest human message only", () => {
    const body = {
      messages: [
        { role: "user", content: "wtf, not what i asked!!!" },
        { role: "assistant", content: "sorry" },
        { role: "user", content: `perfeito, segue\n${reminder("todo list is empty")}` },
      ],
    };
    expect(extractSignals(body)).toMatchObject({ userFeedback: "agrees", frustration: 0, humanTurns: 2 });
  });

  it("lets the client hint replace the regexes and the stall detector", () => {
    const body = { messages: [{ role: "user", content: "wtf, still broken again!!!" }] };
    expect(extractSignals(body)).toMatchObject({ userFeedback: "corrects", frustration: 0.9, stall: false });
    expect(extractSignals(body, { hint: { feedback: "neutral", frustration: 0.1, stall: true } }))
      .toMatchObject({ userFeedback: "neutral", frustration: 0.1, stall: true });
  });

  it("treats tool results carrying only harness reminders as a continuation, not a human turn", () => {
    const body = {
      messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }, { type: "text", text: reminder("todo list") }] },
      ],
    };
    expect(extractSignals(body)).toMatchObject({ turnKind: "tool_continuation", humanTurns: 1, humanText: "fix it" });

    body.messages[2].content.push({ type: "text", text: "actually, stop" });
    expect(extractSignals(body)).toMatchObject({ turnKind: "human", humanTurns: 2 });
  });

  it("flags redcode's title prompt as housekeeping", () => {
    const body = {
      system: "You are a title generator. You output ONLY a thread title. Nothing else.",
      messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, { role: "user", content: "debug 500 errors" }],
    };
    expect(extractSignals(body).housekeeping).toBe(true);
    const inline = { messages: [{ role: "user", content: "Generate a brief title that would help the user find this conversation later.\n\ndebug 500 errors" }] };
    expect(extractSignals(inline).housekeeping).toBe(true);
  });

  it("keeps feedback and frustration in the persisted meta", () => {
    const meta = signalsMeta(extractSignals({ messages: [{ role: "user", content: "no, i meant the other one" }] }));
    expect(meta).toMatchObject({ userFeedback: "corrects", frustration: 0, humanTurns: 1 });
  });
});

describe("resolveModelDecision needsDeliberation", () => {
  const models = ["cheap/m", "mid/m", "pricey/m"];
  const price = { "cheap/m": 0.1, "mid/m": 1, "pricey/m": 10 };
  const answers = {
    model: { type: "choice", choice: "cheap/m", confidence: 0.9, probabilities: { "cheap/m": 0.9, "mid/m": 0.05, "pricey/m": 0.05 } },
    needs_reasoning: { type: "noul", noul: 0.2 },
  };

  it("applies a confident cheap pick normally", () => {
    expect(resolveModelDecision({ answers, models, priceOf: (m) => price[m] }).apply).toBe(true);
  });

  it("refuses the cheapest model when signals demand deliberation", () => {
    const decision = resolveModelDecision({ answers, models, priceOf: (m) => price[m], needsDeliberation: true });
    expect(decision.apply).toBe(false);
    expect(decision.reason).toBe("signals_disagree");
  });
});

describe("decideComboModel housekeeping", () => {
  it("routes title generation to the cheapest member without a decision call", async () => {
    const body = { system: "You are coming up with a succinct title for a coding session.", messages: [{ role: "user", content: "…" }] };
    let asked = false;
    const target = { url: "http://jev.invalid", fetchImpl: async () => { asked = true; throw new Error("must not be called"); } };
    const result = await decideComboModel({
      body,
      models: ["cheap/m", "pricey/m"],
      ranked: ["cheap/m", "pricey/m"],
      comboName: "auto",
      config: { model: "jev-latest", timeoutMs: 100 },
      target,
      signals: extractSignals(body),
    });
    expect(asked).toBe(false);
    expect(result.models[0]).toBe("cheap/m");
    expect(result.decision).toMatchObject({ apply: true, cause: "housekeeping" });
  });
});
