// Relevance compaction: older tool outputs the decision model judges irrelevant
// are replaced by a marker; errors, short and recent outputs are never touched,
// each output is judged once, and any failure leaves the body as it was.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectToolOutputs, compactByRelevance, resetRelevanceCache } from "../../open-sse/rtk/relevance.js";

const long = (tag) => `${tag} `.repeat(120);

function claudeBody() {
  const messages = [{ role: "user", content: "start" }];
  ["a", "b", "c", "d"].forEach((id, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: `tool_${id}`, input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: id === "b", content: long(id) }] });
  });
  messages.push({ role: "user", content: "now fix the login bug" });
  return { messages };
}

beforeEach(() => resetRelevanceCache());

describe("collectToolOutputs", () => {
  it("finds outputs across OpenAI, Claude and Responses shapes with their tool names", () => {
    const openai = { messages: [
      { role: "assistant", tool_calls: [{ id: "x", function: { name: "grep" } }] },
      { role: "tool", tool_call_id: "x", content: "hits" },
    ] };
    const responses = { input: [
      { type: "function_call", call_id: "y", name: "ls" },
      { type: "function_call_output", call_id: "y", output: "files" },
    ] };
    expect(collectToolOutputs(openai)).toMatchObject([{ id: "x", name: "grep", text: "hits" }]);
    expect(collectToolOutputs(responses)).toMatchObject([{ id: "y", name: "ls", text: "files" }]);
    expect(collectToolOutputs(claudeBody()).map((o) => [o.id, o.isError])).toEqual([["a", false], ["b", true], ["c", false], ["d", false]]);
  });
});

describe("compactByRelevance", () => {
  it("asks about old, long, successful outputs only and drops the low-scored ones", async () => {
    const body = claudeBody();
    const ask = vi.fn(async (state, questions) => {
      expect(state).toContain("now fix the login bug");
      // Only "a": "b" is an error, "c" and "d" are the two most recent outputs.
      expect(Object.keys(questions)).toEqual(["relevant_0"]);
      expect(questions.relevant_0.instructions).toContain("tool_a");
      return { relevant_0: { type: "noul", noul: 0.05 } };
    });
    const stats = await compactByRelevance(body, { ask });
    expect(stats).toMatchObject({ judged: 1, dropped: 1 });
    expect(body.messages[2].content[0].content).toMatch(/^\[RedRouter: tool output omitted/);
    expect(body.messages[4].content[0].content).toBe(long("b"));
  });

  it("judges each output once and reuses the score", async () => {
    const ask = vi.fn(async () => ({ relevant_0: { type: "noul", noul: 0.9 } }));
    await compactByRelevance(claudeBody(), { ask });
    const again = claudeBody();
    await compactByRelevance(again, { ask });
    expect(ask).toHaveBeenCalledOnce();
    expect(again.messages[2].content[0].content).toBe(long("a"));
  });

  it("fails open: no answer or a throwing asker leaves the body untouched", async () => {
    const body = claudeBody();
    const before = JSON.stringify(body);
    await compactByRelevance(body, { ask: async () => null });
    await compactByRelevance(body, { ask: async () => { throw new Error("down"); } });
    expect(JSON.stringify(body)).toBe(before);
  });
});
