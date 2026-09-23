// Adaptive Claude thinking: models that list xhigh (Opus 4.7+, Opus 5.x, Sonnet 5,
// Fable 5.x) receive it as-is instead of a downgrade to high, and the adaptive
// block keeps display "summarized" — Claude 4.7+ returns empty thinking text
// without it, and models that cannot disable thinking get it by default.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

const apply = (model, body, provider = "claude") => applyThinking(FORMATS.CLAUDE, model, structuredClone(body), provider);

describe("Claude effort levels", () => {
  it("Opus 5.5 takes low..max, xhigh included, and cannot disable thinking", () => {
    expect(getThinkingLevels("claude", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it.each(["claude-opus-5", "claude-opus-4-7", "claude-opus-4.8", "claude-sonnet-5", "claude-fable-5-1"])(
    "%s lists xhigh",
    (model) => {
      expect(getThinkingLevels("claude", model)).toContain("xhigh");
    },
  );

  it("Opus 4.6 keeps its level list without xhigh", () => {
    expect(getThinkingLevels("claude", "claude-opus-4-6")).not.toContain("xhigh");
  });
});

describe("Claude output_config.effort", () => {
  it.each(["xhigh", "max"])("passes %s through for Opus 5.5", (effort) => {
    const out = apply("claude-opus-5-5", { output_config: { effort } });
    expect(out.output_config).toEqual({ effort });
  });

  it("passes an OpenAI-side xhigh through for Opus 5.5", () => {
    const out = apply("claude-opus-5-5", { reasoning_effort: "xhigh" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });

  it("maps xhigh to high for Opus 4.6, which has no xhigh", () => {
    const out = apply("claude-opus-4-6", { reasoning_effort: "xhigh" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("clamps none on Opus 5.5 to low instead of disabling thinking", () => {
    const out = apply("claude-opus-5-5", { reasoning_effort: "none" });
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "low" });
  });
});

describe("Claude adaptive thinking display", () => {
  it("adds display summarized for a model that cannot disable thinking", () => {
    const out = apply("claude-opus-5-5", { reasoning_effort: "high" });
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("keeps a client's own display", () => {
    const opus55 = apply("claude-opus-5-5", { thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" } });
    expect(opus55.thinking).toEqual({ type: "adaptive", display: "omitted" });

    const opus48 = apply("claude-opus-4-8", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } });
    expect(opus48.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("leaves models that can disable thinking with a bare adaptive block", () => {
    const out = apply("claude-opus-4-8", { reasoning_effort: "high" });
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("still disables thinking for none where the model allows it", () => {
    const out = apply("claude-opus-4-8", { reasoning_effort: "none" });
    expect(out.thinking).toEqual({ type: "disabled" });
  });
});

describe("normalizeClaudePassthrough display", () => {
  it("adds display summarized to a bare adaptive block for Opus 5.5 without mutating the caller's thinking", () => {
    const thinking = { type: "adaptive" };
    const out = normalizeClaudePassthrough({ model: "claude-opus-5-5", thinking, messages: [] }, "claude-opus-5-5");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(thinking).toEqual({ type: "adaptive" });
  });

  it("keeps a client's display and leaves models that can disable thinking alone", () => {
    const kept = normalizeClaudePassthrough({ thinking: { type: "adaptive", display: "omitted" }, messages: [] }, "claude-opus-5-5");
    expect(kept.thinking).toEqual({ type: "adaptive", display: "omitted" });

    const opus48 = normalizeClaudePassthrough({ thinking: { type: "adaptive" }, messages: [] }, "claude-opus-4-8");
    expect(opus48.thinking).toEqual({ type: "adaptive" });
  });
});
