import assert from "node:assert/strict";
import test from "node:test";

const { claudeToOpenAIResponse } = await import(
  "../../../open-sse/translator/response/claude-to-openai.ts"
);
const { ensureHistoryEndsWithUser } = await import(
  "../../../open-sse/translator/request/openai-to-gemini/helpers.ts"
);
const { hoistToolResultImages, prepareClaudeRequest } = await import(
  "../../../open-sse/translator/helpers/claudeHelper.ts"
);
const { openaiToAntigravityRequest } = await import(
  "../../../open-sse/translator/request/openai-to-gemini.ts"
);

type Chunk = { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };

function run(events: Array<Record<string, unknown>>): Chunk[] {
  const state = {
    toolCalls: new Map(),
    toolNameMap: new Map(),
    messageId: "msg_t",
    model: "claude-test",
    toolCallIndex: 0,
  };
  return events.flatMap((event) => {
    const out = claudeToOpenAIResponse(event, state);
    return (Array.isArray(out) ? out : out ? [out] : []) as Chunk[];
  });
}

test("a Claude refusal ends as content_filter and keeps its explanation", () => {
  const chunks = run([
    { type: "message_start", message: { id: "m1", model: "claude-test" } },
    {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { explanation: "I cannot help with that." } },
    },
  ]);
  const finish = chunks.flatMap((c) => c.choices ?? []).find((c) => c.finish_reason);
  assert.equal(finish?.finish_reason, "content_filter");
  const text = chunks.flatMap((c) => c.choices ?? []).map((c) => c.delta?.content ?? "").join("");
  assert.match(text, /cannot help/);
});

test("an ordinary end_turn is still a stop", () => {
  const chunks = run([
    { type: "message_start", message: { id: "m2", model: "claude-test" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);
  assert.equal(chunks.flatMap((c) => c.choices ?? []).find((c) => c.finish_reason)?.finish_reason, "stop");
});

test("Gemini history that ends on a model turn gets a user turn", () => {
  const plain = ensureHistoryEndsWithUser([
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hello" }] },
  ]);
  assert.equal(plain.at(-1)?.role, "user");
  assert.deepEqual(plain.at(-1)?.parts, [{ text: "Continue." }]);

  const withCall = ensureHistoryEndsWithUser([
    { role: "user", parts: [{ text: "run it" }] },
    { role: "model", parts: [{ functionCall: { name: "shell", id: "c1", args: {} } }] },
  ]);
  const reply = withCall.at(-1)?.parts[0] as { functionResponse?: { name: string; id?: string } };
  assert.equal(withCall.at(-1)?.role, "user");
  assert.equal(reply.functionResponse?.name, "shell");
  assert.equal(reply.functionResponse?.id, "c1");

  const done = [{ role: "user", parts: [{ text: "hi" }] }];
  assert.equal(ensureHistoryEndsWithUser(done), done);
});

test("Antigravity envelopes never end on a model turn", () => {
  const body = {
    model: "gemini-3-pro",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
  const envelope = openaiToAntigravityRequest("gemini-3-pro", body, false, { projectId: "p" });
  assert.equal(envelope.request.contents.at(-1)?.role, "user");
});

const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const withToolImage = () => ({
  model: "x",
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }, IMAGE] }],
    },
  ],
});

test("tool-result images move to the user turn for Claude-compatible gateways", () => {
  const out = hoistToolResultImages(withToolImage() as never) as ReturnType<typeof withToolImage>;
  const blocks = out.messages[1].content as Array<{ type: string; content?: Array<{ type: string }> }>;
  assert.equal(blocks[0].type, "tool_result");
  assert.ok(!blocks[0].content?.some((part) => part.type === "image"));
  assert.ok(blocks.some((block) => block.type === "image"));
});

test("Anthropic itself keeps images inside the tool result", () => {
  for (const provider of ["claude", "anthropic-compatible-x", "vertex"]) {
    const out = prepareClaudeRequest(withToolImage() as never, provider) as ReturnType<typeof withToolImage>;
    const blocks = out.messages[1].content as Array<{ type: string; content?: Array<{ type: string }> }>;
    assert.ok(blocks[0].content?.some((part) => part.type === "image"), provider);
  }
  const hoisted = prepareClaudeRequest(withToolImage() as never, "opencode-go") as ReturnType<typeof withToolImage>;
  const blocks = hoisted.messages[1].content as Array<{ type: string }>;
  assert.ok(blocks.some((block) => block.type === "image"));
});

const { openaiToClaudeRequest } = await import(
  "../../../open-sse/translator/request/openai-to-claude.ts"
);

test("a client that sets reasoning_effort gets Claude's thinking text back", () => {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    reasoning_effort: "medium",
    messages: [{ role: "user", content: "think about it" }],
  };
  const out = openaiToClaudeRequest("claude-sonnet-4-5", body, false) as {
    thinking?: { display?: string };
  };
  assert.ok(out.thinking, "reasoning_effort should enable thinking");
  assert.equal(out.thinking?.display, "summarized");

  const plain = openaiToClaudeRequest(
    "claude-sonnet-4-5",
    { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    false
  ) as { thinking?: unknown };
  assert.equal(plain.thinking, undefined);
});
