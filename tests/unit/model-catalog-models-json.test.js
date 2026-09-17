import { afterEach, describe, expect, it } from "vitest";

import { getCapabilitiesForModel, setCatalogSource } from "../../open-sse/providers/capabilities.js";

afterEach(() => {
  setCatalogSource(null);
});

describe("models.dev model-agnostic limits fallback", () => {
  it("fills the context window when the gateway has no own limits", () => {
    setCatalogSource({
      getModalities: () => null,
      getLimits: () => null,
      // glm-4.6 from models.dev/models.json: 204800/131072
      getLimitsByModel: (model) => (model === "glm-4.6" ? { contextWindow: 204800, maxOutput: 131072 } : null),
    });
    expect(getCapabilitiesForModel("unknown-gateway", "glm-4.6").contextWindow).toBe(204800);
    expect(getCapabilitiesForModel("unknown-gateway", "glm-4.6").maxOutput).toBe(131072);
  });

  it("hands the raw model id to the fallback, letting it strip the vendor prefix", () => {
    // Mirrors getModelLimits in catalogOverride.js: the capabilities layer must
    // pass the raw model string so the reader can baseId-strip
    // "zai-org/glm-4.6" down to the models.json key "glm-4.6".
    const seen = [];
    setCatalogSource({
      getModalities: () => null,
      getLimits: () => null,
      getLimitsByModel: (model) => {
        seen.push(model);
        const base = model.includes("/") ? model.split("/").pop() : model;
        return base === "glm-4.6" ? { contextWindow: 204800, maxOutput: 131072 } : null;
      },
    });
    expect(getCapabilitiesForModel("openrouter", "zai-org/glm-4.6").contextWindow).toBe(204800);
    expect(seen).toContain("zai-org/glm-4.6");
  });

  it("keeps the gateway's own numbers ahead of the model-agnostic fallback", () => {
    setCatalogSource({
      getModalities: () => null,
      getLimits: () => ({ contextWindow: 128000, maxOutput: 32768 }),
      getLimitsByModel: () => ({ contextWindow: 204800, maxOutput: 131072 }),
    });
    expect(getCapabilitiesForModel("kimi", "kimi-k2.5").contextWindow).toBe(128000);
    expect(getCapabilitiesForModel("kimi", "kimi-k2.5").maxOutput).toBe(32768);
  });

  it("leaves the default window when neither layer describes the model", () => {
    setCatalogSource({ getModalities: () => null, getLimits: () => null, getLimitsByModel: () => null });
    expect(getCapabilitiesForModel("unknown-gateway", "totally-unknown-model").contextWindow).toBe(200000);
  });
});
