import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_DIR ||= `${process.env.TMPDIR || "/tmp"}/redrouter-compaction-anchor-${process.pid}`;

const { compressContext, estimateTokens, resetPurifyAnchors } =
  await import("../../../open-sse/services/contextManager.ts");

type Message = { role: string; content: string };

const conversation = (turns: number): Message[] => {
  const messages: Message[] = [{ role: "system", content: "You are a coding agent." }];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: `Request ${turn}: ${"detail ".repeat(60)}` });
    messages.push({ role: "assistant", content: `Answer ${turn}: ${"result ".repeat(60)}` });
  }
  return messages;
};

/** How many times the start of the sent prompt changed while a conversation only grew. */
function prefixRewrites(anchorKey: string | undefined): number {
  resetPurifyAnchors();
  const maxTokens = estimateTokens(conversation(12));
  let previous: Message[] | null = null;
  let rewrites = 0;
  for (let turn = 12; turn < 60; turn++) {
    const sent = compressContext(
      { model: "test", messages: conversation(turn) },
      { maxTokens, reserveTokens: 0, anchorKey }
    ).body as { messages: Message[] };
    if (previous) {
      const shared = Math.min(previous.length, sent.messages.length);
      const stable = previous
        .slice(0, shared)
        .every(
          (message, index) => JSON.stringify(message) === JSON.stringify(sent.messages[index])
        );
      if (!stable) rewrites++;
    }
    previous = sent.messages;
  }
  return rewrites;
}

test("without an anchor the window slides and rewrites the prefix on most turns", () => {
  assert.ok(prefixRewrites(undefined) > 20);
});

test("with an anchor the window is re-cut only when it stops fitting", () => {
  const rewrites = prefixRewrites("conversation-a");
  assert.ok(rewrites <= 12, `expected a handful of rewrites, saw ${rewrites}`);
  assert.ok(rewrites > 0, "the window has to move eventually");
});

test("every anchored request still fits the budget", () => {
  resetPurifyAnchors();
  const maxTokens = estimateTokens(conversation(12));
  for (let turn = 12; turn < 40; turn++) {
    const sent = compressContext(
      { model: "test", messages: conversation(turn) },
      { maxTokens, reserveTokens: 0, anchorKey: "conversation-b" }
    ).body as { messages: Message[] };
    assert.ok(estimateTokens(sent.messages) <= maxTokens, `turn ${turn} exceeds the budget`);
  }
});

test("conversations do not share an anchor", () => {
  resetPurifyAnchors();
  const maxTokens = estimateTokens(conversation(12));
  const cut = (key: string, turns: number) =>
    (
      compressContext(
        { model: "test", messages: conversation(turns) },
        { maxTokens, reserveTokens: 0, anchorKey: key }
      ).body as { messages: Message[] }
    ).messages[1];
  const first = cut("conversation-c", 30);
  const other = cut("conversation-d", 20);
  assert.notDeepEqual(first, other);
});
