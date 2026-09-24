import { describe, expect, it } from "vitest";
import { providerIdOfToken, publicModelId, publicModelRef, sameModelRef } from "../../src/shared/utils/modelRef.js";

describe("modelRef", () => {
  it("resolves every provider token to its provider", () => {
    expect(providerIdOfToken("cx")).toBe("codex");
    expect(providerIdOfToken("codex")).toBe("codex");
    expect(providerIdOfToken("cc")).toBe("claude");
    expect(providerIdOfToken("claude-code")).toBe("claude");
    expect(providerIdOfToken("my-combo")).toBeNull();
    expect(providerIdOfToken("")).toBeNull();
  });

  it("writes built-in models as <slug>/<model>", () => {
    expect(publicModelId("codex", "gpt-5.5")).toBe("codex/gpt-5.5");
    expect(publicModelId("claude", "claude-opus-5")).toBe("claude-code/claude-opus-5");
    expect(publicModelId("opencode-go", "glm-5.3-flash")).toBe("opencode-go/glm-5.3-flash");
  });

  it("rewrites legacy short codes and leaves everything else alone", () => {
    expect(publicModelRef("cx/gpt-5.5")).toBe("codex/gpt-5.5");
    expect(publicModelRef("ocg/glm-5.3-flash")).toBe("opencode-go/glm-5.3-flash");
    expect(publicModelRef("cc/claude-opus-5")).toBe("claude-code/claude-opus-5");
    // already readable
    expect(publicModelRef("codex/gpt-5.5")).toBe("codex/gpt-5.5");
    // model ids that carry their own slashes keep them
    expect(publicModelRef("openrouter/z-ai/glm-5.3-flash")).toBe("openrouter/z-ai/glm-5.3-flash");
    // combo names, custom-node and per-connection prefixes are not provider tokens
    expect(publicModelRef("my-combo")).toBe("my-combo");
    expect(publicModelRef("codex-work/gpt-5.5")).toBe("codex-work/gpt-5.5");
    expect(publicModelRef("openai-compatible-chat-1234/glm-4.7")).toBe("openai-compatible-chat-1234/glm-4.7");
    expect(publicModelRef("/weird")).toBe("/weird");
    expect(publicModelRef(undefined)).toBeUndefined();
  });

  it("recognises two spellings of the same model", () => {
    expect(sameModelRef("cx/gpt-5.5", "codex/gpt-5.5")).toBe(true);
    expect(sameModelRef("cc/claude-opus-5", "claude-code/claude-opus-5")).toBe(true);
    expect(sameModelRef("cx/gpt-5.5", "codex/gpt-5.4")).toBe(false);
    expect(sameModelRef("my-combo", "my-combo")).toBe(true);
    expect(sameModelRef(null, "codex/gpt-5.5")).toBe(false);
  });
});
