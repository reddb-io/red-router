// Client anthropic-beta flags merge into ours; capability overrides win over the
// tables; a combo's cost-class policy decides which members it may fall back to.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeAnthropicBeta, selectAnthropicBeta } from "../../open-sse/providers/shared.js";
import { getCapabilitiesForModel, getBaseCapabilitiesForModel, setCapabilityOverrideSource } from "../../open-sse/providers/capabilities.js";
import { applyCostClassPolicy, costClassOf } from "../../open-sse/services/combo.js";

describe("anthropic-beta", () => {
  it("keeps our flags and adds the client's, each once", () => {
    expect(mergeAnthropicBeta("a,b", "b, context-1m-2025-08-07")).toBe("a,b,context-1m-2025-08-07");
    expect(mergeAnthropicBeta("a", "")).toBe("a");
  });

  it("reaches the upstream header for the claude provider", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("claude");
    const headers = executor.buildHeaders({ apiKey: "sk", rawHeaders: { "anthropic-beta": "context-1m-2025-08-07" } }, true, undefined, "claude-opus-5-5");
    const flags = headers["Anthropic-Beta"].split(",");
    expect(flags).toContain("context-1m-2025-08-07");
    for (const flag of selectAnthropicBeta("claude-opus-5-5").split(",")) expect(flags).toContain(flag);
  });

  it("still strips the Claude Code identity flag for third-party anthropic-compatible gateways", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("anthropic-compatible-x");
    const headers = executor.buildHeaders({
      apiKey: "sk",
      providerSpecificData: { baseUrl: "https://gateway.example/v1" },
      rawHeaders: { "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07" },
    }, true, undefined, "claude-sonnet-5");
    const flags = (headers["Anthropic-Beta"] || "").split(",");
    expect(flags).toContain("context-1m-2025-08-07");
    expect(flags).not.toContain("claude-code-20250219");
  });
});

describe("capability overrides", () => {
  afterEach(() => setCapabilityOverrideSource(null));

  it("win over the tables for the matching model only", () => {
    const base = getBaseCapabilitiesForModel("openai", "gpt-4o");
    setCapabilityOverrideSource((provider, model) => (provider === "openai" && model === "gpt-4o" ? { vision: !base.vision, contextWindow: 12345 } : null));
    expect(getCapabilitiesForModel("openai", "gpt-4o")).toMatchObject({ vision: !base.vision, contextWindow: 12345 });
    expect(getCapabilitiesForModel("openai", "gpt-4o-mini").contextWindow).not.toBe(12345);
    expect(getBaseCapabilitiesForModel("openai", "gpt-4o").vision).toBe(base.vision);
  });

  it("load from the kv store and apply by provider alias or any provider", async () => {
    const { saveCapabilityOverride, loadCapabilityOverrides, normalizeCapabilityOverride } = await import("@/lib/capabilityOverrides.js");
    expect(normalizeCapabilityOverride({ vision: "yes", contextWindow: -1, maxOutput: "4096", bogus: true })).toEqual({ maxOutput: 4096 });
    await saveCapabilityOverride("cc", "claude-sonnet-5", { thinkingCanDisable: true });
    await saveCapabilityOverride("*", "gpt-4o", { contextWindow: 999 });
    expect(getCapabilitiesForModel("claude", "claude-sonnet-5").thinkingCanDisable).toBe(true);
    expect(getCapabilitiesForModel("openrouter", "openai/gpt-4o").contextWindow).toBe(999);
    await saveCapabilityOverride("*", "gpt-4o", null);
    await saveCapabilityOverride("cc", "claude-sonnet-5", null);
    await loadCapabilityOverrides();
    expect(getCapabilitiesForModel("openrouter", "openai/gpt-4o").contextWindow).not.toBe(999);
  });
});

describe("cost-class fallback policy", () => {
  const plan = "cc/claude-sonnet-5";          // Claude Code subscription (OAuth)
  const metered = "openai/gpt-5";             // API key
  const custom = "my-node/some-model";        // unknown provider: never restricted

  beforeEach(() => {
    expect(costClassOf(plan)).toBe("plan");
    expect(costClassOf(metered)).toBe("metered");
    expect(costClassOf(custom)).toBeNull();
  });

  it("allow keeps every member (the default)", () => {
    expect(applyCostClassPolicy([plan, metered, custom]).models).toEqual([plan, metered, custom]);
  });

  it("no-metered stops a plan-led combo from reaching API keys, not the reverse", () => {
    expect(applyCostClassPolicy([plan, metered, custom], "no-metered")).toEqual({ models: [plan, custom], skipped: [metered] });
    expect(applyCostClassPolicy([metered, plan], "no-metered").models).toEqual([metered, plan]);
  });

  it("same-class keeps fallback inside the lead's class both ways", () => {
    expect(applyCostClassPolicy([metered, plan, custom], "same-class")).toEqual({ models: [metered, custom], skipped: [plan] });
  });
});
