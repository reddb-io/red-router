// A reasoning target either caps the client's level ("ceiling", legacy effort
// toggle) or replaces it ("set", reasoning autopilot) — including when the client
// sent no thinking config at all.
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { applyClaudeThinkingTarget } from "../../open-sse/translator/formats/claude.js";

describe("applyThinking goal", () => {
  it("keeps the legacy string ceiling behaviour", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("openai", "gpt-5.6-terra", body, "codex", undefined, null, "low");
    expect(body.reasoning_effort).toBe("low");

    const untouched = {};
    applyThinking("openai", "gpt-5.6-terra", untouched, "codex", undefined, null, "low");
    expect(untouched.reasoning_effort).toBeUndefined();
  });

  it("injects the level when the client sent none (set)", () => {
    const body = {};
    applyThinking("openai", "gpt-5.6-terra", body, "codex", undefined, null, { mode: "set", level: "high" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("raises past the client's own level (set)", () => {
    const body = { reasoning_effort: "low" };
    applyThinking("openai", "gpt-5.6-terra", body, "codex", undefined, null, { mode: "set", level: "high" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("nests the effort for Responses targets", () => {
    const body = {};
    applyThinking("openai-responses", "gpt-5.6-terra", body, "codex", undefined, null, { mode: "set", level: "medium" });
    expect(body.reasoning).toMatchObject({ effort: "medium" });
  });

  it("maps a level onto a Claude budget", () => {
    const body = { max_tokens: 64000 };
    applyThinking("claude", "claude-sonnet-4-5", body, "anthropic", undefined, null, { mode: "set", level: "medium" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("never adds thinking to a model that cannot reason", () => {
    const body = {};
    applyThinking("openai", "gpt-4o-mini", body, "openai", undefined, null, { mode: "set", level: "high" });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("applyClaudeThinkingTarget (Claude Code passthrough)", () => {
  it("rewrites adaptive effort and keeps other output_config fields", () => {
    const body = {
      model: "claude-opus-4-8",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema" } },
    };
    applyClaudeThinkingTarget(body, { mode: "set", level: "low" }, "anthropic");
    expect(body.output_config).toEqual({ format: { type: "json_schema" }, effort: "low" });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("disables thinking for none on models that allow it", () => {
    const body = { model: "claude-opus-4-8", max_tokens: 1000, thinking: { type: "adaptive" }, output_config: { effort: "high" } };
    applyClaudeThinkingTarget(body, { mode: "set", level: "none" }, "anthropic");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("keeps max_tokens above a raised budget", () => {
    const body = { model: "claude-sonnet-4-5", max_tokens: 4096 };
    applyClaudeThinkingTarget(body, { mode: "set", level: "high" }, "anthropic");
    expect(body.thinking.budget_tokens).toBe(24576);
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });
});
