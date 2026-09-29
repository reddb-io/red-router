import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const { planReasoning, resetReasoningSessions, reasoningResponseHeaderValue } =
  await import("../../../src/sse/services/reasoningPlanner.ts");
const { applyReasoningLevel, clientFormatOf } =
  await import("../../../src/sse/handlers/chat/reasoningLevel.ts");

const body = (text: string) => ({
  model: "redrouter/auto",
  messages: [{ role: "user", content: text }],
});

beforeEach(() => resetReasoningSessions());

test("a client that turns the autopilot off keeps its own thinking config", async () => {
  const plan = await planReasoning({
    body: body("Design the migration"),
    settings: { reasoningAutopilot: { mode: "enforce", all: true } },
    headerValue: "off",
  });
  assert.equal(plan, null);
});

test("nothing is decided when the autopilot is not asked for and not configured", async () => {
  assert.equal(await planReasoning({ body: body("hi"), settings: {} }), null);
});

test("a level in the header, or in the hint, is applied as stated without asking System One", async () => {
  let asked = 0;
  const askDeliberation = async () => (asked++, 0.9);
  const byHeader = await planReasoning({
    body: body("hi"),
    settings: {},
    headerValue: "high",
    askDeliberation,
  });
  assert.deepEqual([byHeader?.level, byHeader?.cause, byHeader?.target?.level], ["high", "header", "high"]);
  const byHint = await planReasoning({
    body: body("hi"),
    settings: {},
    hint: { effort: "low" },
    askDeliberation,
  });
  assert.deepEqual([byHint?.level, byHint?.cause], ["low", "hint"]);
  assert.equal(asked, 0);
});

test("`auto` lets System One's read of the step choose the level, enforced even if the autopilot is off", async () => {
  const plan = await planReasoning({
    body: body("Design the database migration plan and reason about the edge cases"),
    settings: { reasoningAutopilot: { mode: "off" } },
    headerValue: "auto",
    sessionId: "s1",
    askDeliberation: async () => 0.9,
  });
  assert.equal(plan?.cause, "jev");
  assert.equal(plan?.deliberation, 0.9);
  // The default ceiling is "high": a very deliberate step is capped there.
  assert.equal(plan?.level, "high");
  assert.deepEqual(plan?.target, { mode: "set", level: "high" });
});

test("a mechanical step gets a low level", async () => {
  const plan = await planReasoning({
    body: body("rename the variable"),
    settings: {},
    headerValue: "auto",
    sessionId: "s2",
    askDeliberation: async () => 0.05,
  });
  assert.ok(["minimal", "low"].includes(String(plan?.level)), `level ${plan?.level}`);
});

test("without an answer from System One the first turn falls back to the local score", async () => {
  const plan = await planReasoning({
    body: body("rename the variable"),
    settings: {},
    headerValue: "auto",
    sessionId: "s3",
    askDeliberation: async () => null,
  });
  assert.equal(plan?.cause, "local");
  assert.ok(plan?.target);
});

test("the level holds through a turn's tool loop and System One is asked once per human turn", async () => {
  let asked = 0;
  const askDeliberation = async () => (asked++, 0.7);
  const first = await planReasoning({
    body: body("Investigate the flaky deployment and fix it"),
    settings: {},
    headerValue: "auto",
    sessionId: "loop",
    askDeliberation,
  });
  // The same human turn continues after a tool call: same last human message.
  const second = await planReasoning({
    body: {
      model: "redrouter/auto",
      messages: [
        { role: "user", content: "Investigate the flaky deployment and fix it" },
        { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "ok" },
      ],
    },
    settings: {},
    headerValue: "auto",
    sessionId: "loop",
    askDeliberation,
  });
  assert.equal(second?.level, first?.level);
  assert.equal(asked, 1);
});

test("shadow mode reports the level but applies nothing", async () => {
  const plan = await planReasoning({
    body: body("Design the migration"),
    settings: { reasoningAutopilot: { mode: "shadow", all: true } },
    sessionId: "shadow",
    askDeliberation: async () => 0.5,
  });
  assert.equal(plan?.target, null);
  assert.match(reasoningResponseHeaderValue(plan!), /; shadow$/);
});

test("the response header names the client's level, the chosen one and why", () => {
  assert.equal(
    reasoningResponseHeaderValue({
      mode: "enforce",
      level: "high",
      cause: "jev",
      from: "low",
      deliberation: 0.7,
      target: { mode: "set", level: "high" },
    }),
    "low->high; cause=jev"
  );
  assert.equal(
    reasoningResponseHeaderValue({
      mode: "enforce",
      level: "medium",
      cause: "header",
      from: null,
      deliberation: null,
      target: { mode: "set", level: "medium" },
    }),
    // No client level is written "-": `<from>-><level>`.
    "-->medium; cause=header"
  );
});

test("the level lands in the client's own field, and only there", () => {
  const chat = applyReasoningLevel({ model: "m", messages: [] }, "high", "openai");
  assert.deepEqual(chat, { model: "m", messages: [], reasoning_effort: "high" });
  const responses = applyReasoningLevel({ input: "x", reasoning: { summary: "auto" } }, "low", "responses");
  assert.deepEqual(responses.reasoning, { summary: "auto", effort: "low" });
  const claude = applyReasoningLevel({ messages: [], output_config: { format: "x" } }, "medium", "claude");
  assert.deepEqual(claude.output_config, { format: "x", effort: "medium" });
  const off = applyReasoningLevel({ messages: [], output_config: { effort: "high" } }, "none", "claude");
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal("output_config" in off, false);
  // A nested effort stays equal to the flat one.
  const nested = applyReasoningLevel({ messages: [], reasoning: { effort: "low" } }, "high", "openai");
  assert.deepEqual([nested.reasoning_effort, (nested.reasoning as { effort: string }).effort], ["high", "high"]);
});

test("the client format follows the endpoint and body shape", () => {
  assert.equal(clientFormatOf("/v1/messages", {}), "claude");
  assert.equal(clientFormatOf("/v1/responses", { input: "x" }), "responses");
  assert.equal(clientFormatOf("/v1/chat/completions", { messages: [] }), "openai");
});
