// GPT-6 through Codex: Sol and Luna are served only to Codex clients >= 0.155.1,
// every GPT-6 model takes reasoning effort low..max (Sol and Luna also none), and
// pricing follows the 2026-09-22 list with the >272K long-context tier.
import { describe, expect, it } from "vitest";
import codex from "../../open-sse/providers/registry/codex.js";
import { CODEX_CLI_VERSION } from "../../open-sse/config/appConstants.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Codex client identity", () => {
  it("advertises Codex 0.155.1 in the User-Agent and version headers", () => {
    expect(CODEX_CLI_VERSION).toBe("0.155.1");
    expect(codex.transport.headers["User-Agent"]).toBe("codex_cli_rs/0.155.1");
    expect(codex.transport.headers.version).toBe("0.155.1");
  });
});

describe("GPT-6 Sol and Luna on Codex", () => {
  it("are offered by the Codex provider", () => {
    const ids = codex.models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]));
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])("%s has the Codex 272K window, 128K output and reasoning", (model) => {
    expect(getCapabilitiesForModel("codex", model)).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
      contextWindow: 272000,
      maxOutput: 128000,
    });
  });

  it.each([
    ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
  ])("%s takes efforts %j", (model, levels) => {
    expect(getThinkingLevels("codex", model)).toEqual(levels);
  });

  it("uses the same GPT-6 levels outside Codex", () => {
    expect(getThinkingLevels("openai", "gpt-6-sol")).toContain("max");
    expect(getThinkingLevels("openai", "gpt-6-astra")).not.toContain("none");
  });
});

describe("GPT-6 effort normalization", () => {
  it.each(["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"])("keeps max for %s in the Codex executor", (model) => {
    const body = new CodexExecutor().transformRequest(model, { model, input: "hi", reasoning: { effort: "max" } }, true, {});
    expect(body.reasoning.effort).toBe("max");
  });

  it("raises minimal to low, which GPT-6 does not accept", () => {
    const body = new CodexExecutor().transformRequest("gpt-6-sol", { model: "gpt-6-sol", input: "hi", reasoning_effort: "minimal" }, true, {});
    expect(body.reasoning.effort).toBe("low");
  });

  it.each([["codex"], ["openai"]])("keeps max through applyThinking for %s", (provider) => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-6-sol", { reasoning_effort: "max" }, provider);
    expect(out.reasoning_effort).toBe("max");
  });

  it("clamps none on Astra to low, its lowest effort", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-6-astra", { reasoning_effort: "none" }, "codex");
    expect(out.reasoning_effort).toBe("low");
  });

  it("still clamps max to xhigh for models without max", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { reasoning_effort: "max" }, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });
});

describe("GPT-6 pricing", () => {
  it.each([
    ["gpt-6-sol", { input: 2, output: 10, cached: 0.2 }, { input: 4, output: 15 }],
    ["gpt-6-luna", { input: 0.1, output: 0.5, cached: 0.01 }, { input: 0.2, output: 0.75 }],
    ["gpt-6-astra", { input: 10, output: 50 }, { input: 20, output: 75 }],
  ])("prices %s with a >272K tier", (model, base, longContext) => {
    const pricing = getPricingForModel("codex", model);
    expect(pricing).toMatchObject(base);
    expect(pricing.long_context).toMatchObject({ threshold: 272000, ...longContext });
  });

  it("bills the long-context rate only above 272K input tokens", () => {
    const pricing = getPricingForModel("codex", "gpt-6-sol");
    const short = calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 0 }, { ...pricing, long_context: { ...pricing.long_context, threshold: 2_000_000 } });
    const long = calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 0 }, pricing);
    expect(short).toBeCloseTo(2);
    expect(long).toBeCloseTo(4);
  });
});
