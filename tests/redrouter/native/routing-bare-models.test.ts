import assert from "node:assert/strict";
import { test } from "node:test";

const bare = await import("../../../src/lib/routing/bareModels.ts");

const catalog = [
  { id: "openai/gpt-4o", root: "gpt-4o", owned_by: "openai", context_length: 128000 },
  { id: "openrouter/openai/gpt-4o", root: "openai/gpt-4o", owned_by: "openrouter" },
  { id: "kiro/claude-sonnet-4.5", root: "claude-sonnet-4.5", owned_by: "kiro" },
  { id: "cc/claude-sonnet-4.5", root: "claude-sonnet-4.5", owned_by: "claude" },
  {
    id: "openai/text-embedding-3-small",
    root: "text-embedding-3-small",
    owned_by: "openai",
    type: "embedding",
  },
  { id: "fast", owned_by: "combo" },
  { id: "groq/llama-3.3-70b", root: "llama-3.3-70b", owned_by: "groq" },
];

test("bare keys ignore case and every namespace", () => {
  assert.equal(bare.bareKey("openai/gpt-4o"), "gpt-4o");
  assert.equal(bare.bareKey("openrouter/OpenAI/GPT-4o"), "gpt-4o");
  assert.equal(bare.bareKey("gpt-4o"), "gpt-4o");
  assert.equal(bare.bareKey("  gpt-4o  "), "gpt-4o");
  assert.equal(bare.bareKey(""), "");
});

test("only provider chat models take part; combos and other modalities do not", () => {
  assert.equal(bare.isChatProviderModel(catalog[0]), true);
  assert.equal(bare.isChatProviderModel(catalog[4]), false, "embedding");
  assert.equal(bare.isChatProviderModel(catalog[5]), false, "combo");
  assert.equal(
    bare.isChatProviderModel({ id: "gpt-4o", owned_by: "red-router" }),
    false,
    "already bare"
  );
});

test("the ranker follows the priority list; unlisted providers come after, in catalog order", () => {
  const rank = bare.makeRanker(["kiro", "openai"]);
  assert.equal(rank(catalog[2]), 0);
  assert.equal(rank(catalog[0]), 1);
  assert.equal(rank(catalog[6]), 2, "unlisted = after the last listed");
  assert.equal(rank(catalog[1]), 2);
});

test("ranking matches the owner id or the prefix, and honors an alias mapping", () => {
  const rank = bare.makeRanker(["claude"]);
  assert.equal(rank(catalog[3]), 0, "owned_by claude");
  const viaAlias = bare.makeRanker(["claude"], (id) => (id === "cc" ? "claude" : id));
  assert.equal(viaAlias({ id: "cc/x", owned_by: "cc" }), 0, "cc is an alias of claude");
});

test("the collapsed catalog lists each chat model once, from the best provider, under its bare name", () => {
  const out = bare.collapseCatalogToBare(catalog, ["cc", "openai"], (id) =>
    id === "cc" ? "claude" : id
  );
  const ids = out.map((m: { id: string }) => m.id);
  assert.deepEqual(
    ids,
    [
      "gpt-4o",
      "claude-sonnet-4.5",
      "text-embedding-3-small".replace("text", "openai/text"),
      "fast",
      "llama-3.3-70b",
    ].map((v) => (v.startsWith("openai/") ? "openai/text-embedding-3-small" : v))
  );
  const gpt = out.find((m: { id: string }) => m.id === "gpt-4o");
  assert.equal(gpt.owned_by, "red-router", "the provider is not revealed");
  assert.equal(gpt.context_length, 128000, "metadata of the chosen provider is kept");
  const claude = out.find((m: { id: string }) => m.id === "claude-sonnet-4.5");
  assert.equal(claude.owned_by, "red-router");
  // The other modalities and combos are untouched.
  assert.deepEqual(
    out.find((m: { id: string }) => m.id === "fast"),
    catalog[5]
  );
  assert.deepEqual(
    out.find((m: { id: string }) => m.id === "openai/text-embedding-3-small"),
    catalog[4]
  );
});

test("a namespaced provider id (openrouter's openai/gpt-4o) is the same model as gpt-4o", () => {
  const out = bare.collapseCatalogToBare(catalog, [], undefined);
  assert.equal(out.filter((m: { id: string }) => m.id === "gpt-4o").length, 1);
  assert.ok(!out.some((m: { id: string }) => m.id === "openai/gpt-4o"));
});

test("with no priority the first provider in catalog order wins, deterministically", () => {
  const a = bare
    .collapseCatalogToBare(catalog, [], undefined)
    .find((m: { id: string }) => m.id === "gpt-4o");
  assert.equal(a.context_length, 128000, "openai comes before openrouter in the catalog");
  const b = bare
    .collapseCatalogToBare([...catalog].reverse(), [], undefined)
    .find((m: { id: string }) => m.id === "gpt-4o");
  assert.equal(b.context_length, undefined, "reversed catalog: openrouter first");
});

test("provider-only fields never leak into the collapsed entry", () => {
  const out = bare.collapseCatalogToBare(
    [
      {
        id: "x/y",
        root: "y",
        owned_by: "x",
        provider: "x",
        provider_id: "x",
        parent: "x/y",
        ok: 1,
      },
    ],
    []
  );
  assert.deepEqual(Object.keys(out[0]).sort(), ["id", "ok", "owned_by", "root"]);
});

test("targets for a bare request are every matching provider, best first", () => {
  const targets = bare.orderedTargetsFor(catalog, "claude-sonnet-4.5", ["cc", "kiro"], (id) =>
    id === "cc" ? "claude" : id
  );
  assert.deepEqual(
    targets.map((t: { id: string }) => t.id),
    ["cc/claude-sonnet-4.5", "kiro/claude-sonnet-4.5"]
  );
  const swapped = bare.orderedTargetsFor(catalog, "claude-sonnet-4.5", ["kiro", "claude"]);
  assert.deepEqual(
    swapped.map((t: { id: string }) => t.id),
    ["kiro/claude-sonnet-4.5", "cc/claude-sonnet-4.5"]
  );
});

test("a request that still carries a provider prefix resolves to the same targets (prefix ignored)", () => {
  const plain = bare.orderedTargetsFor(catalog, "gpt-4o", ["openai"]);
  assert.deepEqual(bare.orderedTargetsFor(catalog, "openai/gpt-4o", ["openai"]), plain);
  assert.deepEqual(bare.orderedTargetsFor(catalog, "openrouter/openai/GPT-4o", ["openai"]), plain);
  assert.deepEqual(
    plain.map((t: { id: string }) => t.id),
    ["openai/gpt-4o", "openrouter/openai/gpt-4o"]
  );
});

test("unknown models, combos and other modalities give no targets", () => {
  assert.deepEqual(bare.orderedTargetsFor(catalog, "nope", []), []);
  assert.deepEqual(
    bare.orderedTargetsFor(catalog, "fast", []),
    [],
    "a combo is not a provider model"
  );
  assert.deepEqual(bare.orderedTargetsFor(catalog, "text-embedding-3-small", []), []);
  assert.deepEqual(bare.orderedTargetsFor(catalog, "", []), []);
});
