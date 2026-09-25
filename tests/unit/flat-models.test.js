import { describe, expect, it } from "vitest";
import { applyFlatPolicy, offerOf, groupFlatOffers, pinIdFor, versionKey } from "../../src/lib/flatModels.js";

const provider = (id, extra = {}) => ({ id, slug: id, name: id, category: "apikey", subscription: false, ...extra });
const entry = (owned_by, modelId, prov, extra = {}) => ({ id: `${owned_by}/${modelId}`, owned_by, name: modelId, provider: prov, ...extra });

// Prices per million tokens, keyed "provider/model".
const PRICES = {
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
  "openrouter/anthropic/claude-sonnet-4.5": { input: 3.3, output: 16.5 },
  "opencode-zen/jev-1.13": { input: 0.042, output: 0 },
  "opencode-zen/jev-1.13-free": { input: 0, output: 0 },
  "openrouter/typesafe/jev-1.13": { input: 0.042, output: 0 },
};
const priceOf = async (p, m) => PRICES[`${p}/${m}`] || null;

describe("flat model ids", () => {
  it("reads the served provider and model through RedRouter hops", () => {
    expect(offerOf(entry("openrouter", "anthropic/claude-sonnet-4.5", provider("openrouter")))).toMatchObject({
      providerId: "openrouter", modelId: "anthropic/claude-sonnet-4.5", via: [],
    });
    const chained = {
      id: "red-router/red-router/opencode-go/typesafe/jev-1.13",
      owned_by: "red-router",
      name: "JEV 1.13",
      provider: provider("opencode-go", { name: "OpenCode Go" }),
      route: [{ prefix: "red-router", name: "RedRouter" }, { prefix: "red-router", name: "Office RedRouter" }],
    };
    expect(offerOf(chained)).toMatchObject({
      id: "red-router/red-router/opencode-go/typesafe/jev-1.13",
      providerId: "opencode-go",
      modelId: "typesafe/jev-1.13",
      via: [{ slug: "red-router", name: "RedRouter" }, { slug: "red-router", name: "Office RedRouter" }],
    });
    expect(offerOf({ id: "fast", owned_by: "combo", provider: { id: "combo" } })).toBeNull();
  });

  it("groups one model across providers, cheapest offer first", async () => {
    const flat = await groupFlatOffers([
      entry("openrouter", "anthropic/claude-sonnet-4.5", provider("openrouter")),
      entry("anthropic", "claude-sonnet-4-5", provider("anthropic")),
    ], { priceOf });
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ canonical: "anthropic/claude-sonnet-4-5", free: false });
    expect(flat[0].offers.map((o) => o.id)).toEqual(["anthropic/claude-sonnet-4-5", "openrouter/anthropic/claude-sonnet-4.5"]);
    expect(flat[0].id.startsWith("anthropic/claude-sonnet-4")).toBe(true);
  });

  it("never mixes free and paid offers, or two versions, in one entry", async () => {
    const flat = await groupFlatOffers([
      entry("opencode-zen", "jev-1.13", provider("opencode-zen")),
      entry("opencode-zen", "jev-1.13-free", provider("opencode-zen")),
      entry("openrouter", "typesafe/jev-1.13", provider("openrouter")),
      entry("openrouter", "typesafe/jev-1.14", provider("openrouter")),
    ], { priceOf });
    const byId = Object.fromEntries(flat.map((f) => [f.id, f.offers.map((o) => o.id)]));
    expect(byId).toEqual({
      "typesafe/jev-1.13": ["opencode-zen/jev-1.13", "openrouter/typesafe/jev-1.13"],
      "typesafe/jev-1.13:free": ["opencode-zen/jev-1.13-free"],
      "typesafe/jev-1.14": ["openrouter/typesafe/jev-1.14"],
    });
  });

  it("pins the vendor's own offer through an alias, since its id is also the flat id", () => {
    const flatIds = new Set(["openai/gpt-5"]);
    expect(pinIdFor({ id: "openai/gpt-5", aliases: ["oai/gpt-5"] }, flatIds)).toBe("oai/gpt-5");
    expect(pinIdFor({ id: "openai/gpt-5", aliases: [] }, flatIds)).toBeNull();
    expect(pinIdFor({ id: "openrouter/openai/gpt-5", aliases: [] }, flatIds)).toBe("openrouter/openai/gpt-5");
  });

  it("keeps versions apart when normalizing", () => {
    expect(versionKey("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(versionKey("jev-1.13-free")).toBe("jev-1-13");
    expect(versionKey("jev-1.14")).not.toBe(versionKey("jev-1.13"));
  });
});

describe("applyFlatPolicy", () => {
  const offers = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (r) => r.offers.map((o) => o.id);

  it("puts the named offers first in the saved order and keeps the rest in default order", () => {
    const r = applyFlatPolicy(offers, { order: ["c", "a"] });
    expect(ids(r)).toEqual(["c", "a", "b", "d"]);
    expect(r.custom).toBe(true);
  });

  it("ignores offers the policy names that are no longer offered", () => {
    expect(ids(applyFlatPolicy(offers, { order: ["gone", "b"] }))).toEqual(["b", "a", "c", "d"]);
  });

  it("marks switched-off offers unavailable without moving them", () => {
    const r = applyFlatPolicy(offers, { disabled: ["b"] });
    expect(r.offers.map((o) => [o.id, o.available])).toEqual([["a", true], ["b", false], ["c", true], ["d", true]]);
    expect(r.custom).toBe(true);
  });

  it("is not custom when the policy matches the default", () => {
    expect(applyFlatPolicy(offers, { order: ["a", "b"] }).custom).toBe(false);
    expect(applyFlatPolicy(offers, null)).toEqual({ offers: offers.map((o) => ({ ...o, available: true })), custom: false });
  });
});
