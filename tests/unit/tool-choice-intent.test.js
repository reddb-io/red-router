// tool_choice intent must survive OpenAI ↔ Claude translation:
// "none" forbids tool calls and parallel_tool_calls:false ↔ disable_parallel_tool_use.
import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

const openaiTool = { type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } };
const claudeTool = { name: "f", input_schema: { type: "object", properties: {} } };

describe("OpenAI → Claude tool_choice", () => {
  const toClaude = (extra) =>
    openaiToClaudeRequest("claude-sonnet-4.5", { messages: [{ role: "user", content: "hi" }], tools: [openaiTool], ...extra }, false);

  it("keeps none as none", () => {
    expect(toClaude({ tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
  });

  it("maps parallel_tool_calls:false to disable_parallel_tool_use", () => {
    expect(toClaude({ parallel_tool_calls: false }).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(toClaude({ tool_choice: "required", parallel_tool_calls: false }).tool_choice)
      .toEqual({ type: "any", disable_parallel_tool_use: true });
  });

  it("never adds disable_parallel_tool_use to none", () => {
    expect(toClaude({ tool_choice: "none", parallel_tool_calls: false }).tool_choice).toEqual({ type: "none" });
  });

  it("leaves tool_choice untouched when parallel calls are allowed", () => {
    expect(toClaude({ parallel_tool_calls: true }).tool_choice).toBeUndefined();
  });
});

describe("Claude → OpenAI tool_choice", () => {
  const toOpenAI = (tool_choice) =>
    claudeToOpenAIRequest("m", { messages: [{ role: "user", content: "hi" }], tools: [claudeTool], tool_choice }, false);

  it("keeps none as none", () => {
    expect(toOpenAI({ type: "none" }).tool_choice).toBe("none");
  });

  it("maps disable_parallel_tool_use to parallel_tool_calls:false", () => {
    const out = toOpenAI({ type: "auto", disable_parallel_tool_use: true });
    expect(out.tool_choice).toBe("auto");
    expect(out.parallel_tool_calls).toBe(false);
  });
});
