import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("TypeSafe AI provider registry", () => {
  it("registers JEV as a native System One provider, not a chat transport", () => {
    const entry = REGISTRY.find((provider) => provider.id === "typesafe-ai");

    expect(entry).toMatchObject({
      category: "apikey",
      serviceKinds: ["systemOne"],
    });
    expect(entry).not.toHaveProperty("transport");
    expect(PROVIDER_MEDIA["typesafe-ai"].systemOneConfig.baseUrl).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    expect(PROVIDER_MODELS["typesafe-ai"].map((model) => model.id)).toEqual([
      "jev-latest",
      "jev-preview",
      "jev-1.13.0",
    ]);
    expect(resolveProviderAlias("jev")).toBe("typesafe-ai");
    expect(getPricingForModel("typesafe-ai", "jev-latest")).toEqual({ input: 0.042, output: 0 });
  });
});
