// Claude Opus 5.5: catalogued for the Claude provider, adaptive thinking that cannot be
// disabled, and forced tool_choice (any/tool) downgraded to auto — the API returns 400.
import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { CLAUDE_CLI_VERSION } from "../../open-sse/providers/shared.js";
import claude from "../../open-sse/providers/registry/claude.js";

describe("Claude Opus 5.5", () => {
  it("is offered by the Claude provider and advertised with a Claude Code build that serves it", () => {
    expect(claude.models.map((m) => m.id)).toContain("claude-opus-5-5");
    const [major, minor, patch] = CLAUDE_CLI_VERSION.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(2 * 1e6 + 1 * 1e3 + 280);
  });

  it("declares 1M context, 128K output and always-on adaptive thinking", () => {
    expect(getCapabilitiesForModel("claude", "claude-opus-5-5")).toMatchObject({
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
      forcedToolChoice: false,
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("is priced at $4 / $20 per MTok with $0.20 cache reads", () => {
    expect(getPricingForModel("claude", "claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cached: 0.2 });
  });

  it("downgrades forced tool_choice to auto, keeping disable_parallel_tool_use", () => {
    const tools = [{ name: "f", input_schema: { type: "object" } }];
    const forced = prepareClaudeRequest({ model: "claude-opus-5-5", max_tokens: 1000, tools, tool_choice: { type: "tool", name: "f", disable_parallel_tool_use: true }, messages: [{ role: "user", content: "x" }] }, "claude");
    expect(forced.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });

    const none = prepareClaudeRequest({ model: "claude-opus-5-5", max_tokens: 1000, tools, tool_choice: { type: "none" }, messages: [{ role: "user", content: "x" }] }, "claude");
    expect(none.tool_choice).toEqual({ type: "none" });

    const opus5 = prepareClaudeRequest({ model: "claude-opus-5", max_tokens: 1000, tools, tool_choice: { type: "any" }, messages: [{ role: "user", content: "x" }] }, "claude");
    expect(opus5.tool_choice).toEqual({ type: "any" });
  });
});
