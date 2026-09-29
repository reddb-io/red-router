import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const {
  conversationKeyOf,
  diffFingerprints,
  fingerprintBody,
  messagesOf,
  observePrefix,
  resetPrefixObservations,
} = await import("../../../src/lib/promptCache/prefixDiagnostics.ts");

const turn = (n: number) => [
  { role: "user", content: `ask ${n}` },
  { role: "assistant", content: `answer ${n}` },
];
const conversation = (turns: number) => Array.from({ length: turns }, (_, i) => turn(i)).flat();
const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  system: [{ type: "text", text: "You are a coding agent." }],
  tools: [{ name: "read", description: "Read a file" }],
  messages,
  ...extra,
});
const KEY = "conversation-1";

beforeEach(() => resetPrefixObservations());

test("the first request of a conversation has nothing to compare with", () => {
  const seen = observePrefix({ conversationKey: KEY, body: body(conversation(2)) });
  assert.equal(seen.cause, "first_request");
  assert.equal(seen.requestIndex, 1);
  assert.equal(seen.messageCount, 4);
});

test("a request that only appends keeps the whole previous prefix (the cache should hold)", () => {
  observePrefix({ conversationKey: KEY, body: body(conversation(3)) });
  const seen = observePrefix({ conversationKey: KEY, body: body(conversation(4)) });
  assert.equal(seen.cause, "none");
  assert.equal(seen.firstDivergentIndex, -1);
  assert.equal(seen.stablePrefixMessages, 6);
  assert.equal(seen.requestIndex, 2);
});

test("one rewritten old message is reported at its index, with the stable prefix before it", () => {
  const first = conversation(6);
  observePrefix({ conversationKey: KEY, body: body(first) });
  const rewritten = conversation(7);
  rewritten[5] = { role: "assistant", content: "answer 2 (compressed)" };
  const seen = observePrefix({ conversationKey: KEY, body: body(rewritten) });
  assert.equal(seen.cause, "history_mutated");
  assert.equal(seen.firstDivergentIndex, 5);
  assert.equal(seen.stablePrefixMessages, 5);
});

test("a moving compression boundary shows up as an earlier divergence every turn", () => {
  const raw = conversation(10);
  const compress = (upTo: number) =>
    raw.map((message, index) => (index < upTo ? { ...message, content: "…" } : message));
  observePrefix({ conversationKey: KEY, body: body(compress(4)) });
  const second = observePrefix({ conversationKey: KEY, body: body(compress(6)) });
  const third = observePrefix({ conversationKey: KEY, body: body(compress(8)) });
  assert.equal(second.firstDivergentIndex, 4);
  assert.equal(third.firstDivergentIndex, 6);
});

test("tools, system, thinking and tool_choice changes are named, most impactful first", () => {
  const messages = conversation(3);
  const base = fingerprintBody(body(messages));
  const cause = (extra: Record<string, unknown>, mutate?: (b: Record<string, unknown>) => void) => {
    const next = body(messages, extra);
    mutate?.(next);
    return diffFingerprints(base, fingerprintBody(next));
  };
  assert.equal(cause({}, (b) => (b.tools = [{ name: "write" }])).cause, "tools_changed");
  assert.equal(cause({}, (b) => (b.system = [{ type: "text", text: "changed" }])).cause, "system_changed");
  assert.equal(cause({ thinking: { type: "adaptive" } }).cause, "thinking_changed");
  assert.equal(cause({ output_config: { effort: "high" } }).cause, "thinking_changed");
  assert.equal(cause({ tool_choice: { type: "auto" } }).cause, "tool_choice_changed");
  const both = cause({ thinking: { type: "adaptive" } }, (b) => (b.tools = []));
  assert.deepEqual(both.causes, ["tools_changed", "thinking_changed"]);
  assert.equal(both.cause, "tools_changed");
});

test("switching the serving account is reported because caches do not cross accounts", () => {
  observePrefix({ conversationKey: KEY, body: body(conversation(2)), connectionId: "conn-a" });
  const seen = observePrefix({
    conversationKey: KEY,
    body: body(conversation(3)),
    connectionId: "conn-b",
  });
  assert.equal(seen.cause, "account_changed");
});

test("a shorter history is a truncation, not a mutation", () => {
  observePrefix({ conversationKey: KEY, body: body(conversation(5)) });
  const seen = observePrefix({ conversationKey: KEY, body: body(conversation(3)) });
  assert.equal(seen.cause, "history_truncated");
  assert.equal(seen.firstDivergentIndex, 6);
});

test("a conversation idle for more than 30 minutes starts over", () => {
  observePrefix({ conversationKey: KEY, body: body(conversation(2)), now: 1_000 });
  const seen = observePrefix({
    conversationKey: KEY,
    body: body(conversation(3)),
    now: 1_000 + 31 * 60 * 1000,
  });
  assert.equal(seen.cause, "first_request");
  assert.equal(seen.requestIndex, 1);
});

test("the conversation key ignores tools and system, so a change to them is still noticed", () => {
  const messages = conversation(2);
  const a = conversationKeyOf({ body: body(messages), apiKeyId: "k", provider: "claude", model: "m" });
  const b = conversationKeyOf({
    body: body(messages, { tools: [{ name: "other" }], system: "different" }),
    apiKeyId: "k",
    provider: "claude",
    model: "m",
  });
  const other = conversationKeyOf({ body: body([{ role: "user", content: "new topic" }]), apiKeyId: "k", provider: "claude", model: "m" });
  assert.equal(a, b);
  assert.notEqual(a, other);
});

test("Responses `input`, Gemini `contents` and nested `request.contents` are all conversations", () => {
  assert.equal(messagesOf({ input: [1, 2, 3] }).length, 3);
  assert.equal(messagesOf({ contents: [1, 2] }).length, 2);
  assert.equal(messagesOf({ request: { contents: [1] } }).length, 1);
  assert.equal(messagesOf({}).length, 0);
});
