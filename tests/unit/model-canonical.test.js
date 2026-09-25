import { describe, expect, it } from "vitest";
import { normalizeModelName, buildCanonicalMap } from "../../src/lib/modelCatalog/canonicalBuild.js";
import { canonicalFor } from "../../src/lib/modelCatalog/canonical.js";

describe("canonical model map (build)", () => {
  it("normalizes ids so the same model reads alike across providers", () => {
    expect(normalizeModelName("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("meta/llama-3-8b:free")).toBe("llama-3-8b");
    expect(normalizeModelName("typesafe/jev-latest")).toBe("jev");
  });

  it("keeps stated links apart from name guesses, and skips ambiguous names", () => {
    const map = buildCanonicalMap({
      canonicalIds: ["openai/gpt-5", "anthropic/claude-haiku-4-5", "a/dup-model", "b/dup-model"],
      offers: [
        { provider: "azure", id: "gpt-5-deployment", baseModel: "openai/gpt-5" }, // base_model
        { provider: "openai", id: "gpt-5" }, // the vendor's own offer
        { provider: "opencode", id: "claude-haiku-4-5" }, // no base_model: name match
        { provider: "x", id: "dup-model" }, // two candidates: left out
        { provider: "x", id: "unknown-model" },
      ],
    });
    expect(map.offers).toEqual({ azure: { "gpt-5-deployment": "openai/gpt-5" }, openai: { "gpt-5": "openai/gpt-5" } });
    expect(map.inferred).toEqual({ opencode: { "claude-haiku-4-5": "anthropic/claude-haiku-4-5" } });
  });
});

describe("canonical model lookup (vendored map)", () => {
  it("links OpenCode Zen's JEV to TypeSafe's model, as models.dev states", () => {
    expect(canonicalFor("opencode-zen", "jev-1.13")).toEqual({ id: "typesafe/jev-latest", how: "stated" });
    expect(canonicalFor("opencode-zen", "jev-1.13-free")).toEqual({ id: "typesafe/jev-latest", how: "stated" });
  });

  it("links OpenRouter's dotted Claude id to the same canonical model as Anthropic's own", () => {
    const viaOpenRouter = canonicalFor("openrouter", "anthropic/claude-sonnet-4.5");
    const direct = canonicalFor("anthropic", "claude-sonnet-4-5");
    expect(viaOpenRouter?.id).toBe("anthropic/claude-sonnet-4-5");
    expect(direct?.id).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns null when nothing links an offer", () => {
    expect(canonicalFor("openrouter", "nobody/made-this-up-9000")).toBeNull();
    expect(canonicalFor("openrouter", "")).toBeNull();
  });
});
