import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecommendations,
  connectedProviders,
  parseVersion,
  planRecommendedCombos,
  toRecommendationModels,
  toSystemOneModels,
  type CatalogProvider,
  type RecommendationModel,
  type RecommendedComboSpec,
} from "../../../src/lib/modelRecommendations.ts";

// A recommendation entry as the combo-builder adapter emits it, reduced to what ranking reads.
const SUB = { subscription: true };
const PAID = { subscription: false };
const CLAUDE_CODE = { id: "claude", slug: "claude-code", name: "Claude Code", plan: SUB };
const ANTHROPIC = { id: "anthropic", slug: "anthropic", name: "Anthropic", plan: PAID };
const CODEX = { id: "codex", slug: "codex", name: "OpenAI Codex", plan: SUB };
const OPENAI = { id: "openai", slug: "openai", name: "OpenAI", plan: PAID };
const GEMINI = { id: "gemini", slug: "gemini", name: "Gemini", plan: PAID };
const KIRO = { id: "kiro", slug: "kiro", name: "Kiro AI", plan: SUB };

function entry(
  id: string,
  name: string,
  provider: { id: string; slug: string; name: string; plan: { subscription: boolean } },
  extra: Partial<RecommendationModel> = {}
): RecommendationModel {
  return {
    id: `${provider.slug}/${id}`,
    owned_by: provider.slug,
    name,
    provider: { id: provider.id, slug: provider.slug, name: provider.name, ...provider.plan },
    ...extra,
  };
}

test("the family version ignores dates", () => {
  assert.deepEqual(parseVersion("claude-opus-5-5"), [5, 5]);
  assert.deepEqual(parseVersion("gpt-5.6-sol"), [5, 6]);
  assert.deepEqual(parseVersion("claude-opus-4-20250514"), [4, 0]);
  assert.deepEqual(parseVersion("claude-haiku-4-5-20251001"), [4, 5]);
  assert.deepEqual(parseVersion("kimi-for-coding"), [0, 0]);
});

test("default: claude opus beats gpt-6 sol beats gemini pro, newest version first", () => {
  const models = [
    entry("gemini-3.1-pro", "Gemini 3.1 Pro", GEMINI),
    entry("gpt-6-sol", "GPT 6.0 Sol", CODEX),
    entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
    entry("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_CODE),
  ];
  const { recommended } = buildRecommendations(models);
  assert.deepEqual(recommended.default, {
    id: "claude-code/claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: { slug: "claude-code", name: "Claude Code" },
    reason: "Strongest connected coding model (claude-opus family, newest version).",
  });
  assert.equal(buildRecommendations(models.slice(0, 2)).recommended.default?.id, "codex/gpt-6-sol");
  assert.equal(
    buildRecommendations(models.slice(0, 1)).recommended.default?.id,
    "gemini/gemini-3.1-pro"
  );
});

test("a subscription account wins over a metered key serving the same model, without trading capability", () => {
  const twins = [
    entry("claude-opus-5", "Claude Opus 5", ANTHROPIC),
    entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
  ];
  const { recommended, combos } = buildRecommendations(twins);
  assert.equal(recommended.default?.id, "claude-code/claude-opus-5");
  assert.match(
    recommended.default?.reason ?? "",
    /subscription account is preferred over a metered API key/
  );
  // The metered account stays as the fallback.
  assert.deepEqual(combos.find((c) => c.name === "default")?.models, [
    "claude-code/claude-opus-5",
    "anthropic/claude-opus-5",
  ]);

  const capability = [
    entry("claude-opus-5", "Claude Opus 5", ANTHROPIC),
    entry("claude-sonnet-5", "Claude Sonnet 5", CLAUDE_CODE),
  ];
  assert.equal(buildRecommendations(capability).recommended.default?.id, "anthropic/claude-opus-5");
});

test("fast: gpt-6 luna, then gemini flash, then haiku; flash-lite ranks last", () => {
  const models = [
    entry("claude-haiku-4.5", "Claude Haiku 4.5", KIRO),
    entry("gemini-3.8-flash", "Gemini 3.8 Flash", GEMINI),
    entry("gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite", GEMINI),
    entry("gpt-6-luna", "GPT 6.0 Luna", CODEX),
  ];
  const { recommended, combos } = buildRecommendations(models);
  assert.equal(recommended.fast?.id, "codex/gpt-6-luna");
  assert.equal(recommended.fast?.reason, "Cheapest capable fast model (gpt-6-luna family).");
  assert.deepEqual(combos.find((c) => c.name === "fast")?.models, [
    "codex/gpt-6-luna",
    "gemini/gemini-3.8-flash",
    "kiro/claude-haiku-4.5",
  ]);
  assert.equal(
    buildRecommendations(models.slice(0, 1)).recommended.fast?.id,
    "kiro/claude-haiku-4.5"
  );
});

test("review: the review variant of a model with modes, else the default model", () => {
  const models = [
    entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
    entry("gpt-5.5", "GPT 5.5", CODEX, {
      parameters: { modes: ["review"] },
      variants: [{ id: "codex/gpt-5.5-review", name: "GPT 5.5 Review", mode: "review" }],
    }),
  ];
  const { recommended } = buildRecommendations(models);
  assert.equal(recommended.review?.id, "codex/gpt-5.5-review");
  assert.equal(recommended.review?.name, "GPT 5.5 Review");

  const without = buildRecommendations(models.slice(0, 1)).recommended;
  assert.equal(without.review?.id, "claude-code/claude-opus-5");
  assert.equal(
    without.review?.reason,
    "No connected model has a review mode; using the default model."
  );
});

test("systemone is the first JEV model; vision appears only when a model reads images", () => {
  const jev = [
    { id: "jev/other", name: "Other", provider: { slug: "jev", name: "TypeSafe AI (JEV)" } },
    {
      id: "jev/jev-latest",
      name: "JEV Latest",
      provider: { slug: "jev", name: "TypeSafe AI (JEV)" },
    },
  ];
  const models = [entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE)];
  const noVision = buildRecommendations(models, jev).recommended;
  assert.equal(noVision.systemone?.id, "jev/jev-latest");
  assert.equal("vision" in noVision, false);

  const vision = buildRecommendations([
    ...models,
    entry("gpt-6-luna", "GPT 6.0 Luna", CODEX, { capabilities: { vision: true } }),
  ]).recommended;
  assert.equal(vision.vision?.id, "codex/gpt-6-luna");
  assert.equal(vision.systemone, null);
});

test("with no ranked family the first catalog model is used; combos are ignored; nothing connected recommends nothing", () => {
  const custom = { id: "openai-compatible-x", slug: "local", name: "Local", plan: PAID };
  const models = [
    { id: "default", owned_by: "combo", name: "default", provider: { id: "combo", name: "Combo" } },
    entry("llama-4", "Llama 4", custom),
  ];
  const { recommended, combos } = buildRecommendations(models);
  assert.equal(recommended.default?.id, "local/llama-4");
  assert.equal(recommended.fast?.id, "local/llama-4");
  assert.deepEqual(
    combos.map((c) => [c.name, c.models]),
    [
      ["default", ["local/llama-4"]],
      ["fast", ["local/llama-4"]],
      ["review", ["local/llama-4"]],
    ]
  );
  assert.deepEqual(buildRecommendations([]).recommended, {
    default: null,
    fast: null,
    review: null,
    systemone: null,
  });
  assert.deepEqual(buildRecommendations([]).combos, []);
});

test("combo members span providers first and are capped at three", () => {
  const models = [
    entry("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_CODE),
    entry("claude-opus-5", "Claude Opus 5", CLAUDE_CODE),
    entry("claude-opus-5", "Claude Opus 5", KIRO),
    entry("gpt-6-sol", "GPT 6.0 Sol", CODEX),
    entry("gpt-6-sol", "GPT 6.0 Sol", OPENAI),
  ];
  const combo = buildRecommendations(models).combos.find((c) => c.name === "default");
  assert.deepEqual(combo?.models, [
    "claude-code/claude-opus-5-5",
    "kiro/claude-opus-5",
    "codex/gpt-6-sol",
  ]);
});

test("planning creates missing combos, updates changed ones and leaves matching ones alone", () => {
  const specs: RecommendedComboSpec[] = [
    { name: "default", role: "default", models: ["claude-code/claude-opus-5"], reason: "r" },
    { name: "fast", role: "fast", models: ["codex/gpt-6-luna"], reason: "r" },
    { name: "review", role: "review", models: ["codex/gpt-5.5-review"], reason: "r" },
  ];
  const plan = planRecommendedCombos(specs, [
    { id: "c1", name: "default", models: ["claude-code/claude-opus-5"] },
    { id: "c2", name: "fast", models: ["cc/claude-haiku-4.5"] },
  ]);
  assert.deepEqual(
    plan.map((item) => [item.name, item.action, item.comboId]),
    [
      ["default", "unchanged", "c1"],
      ["fast", "update", "c2"],
      ["review", "create", undefined],
    ]
  );
  assert.deepEqual(plan[1].current, ["cc/claude-haiku-4.5"]);
});

test("a role no connected account can serve is blocked, not dropped", () => {
  const plan = planRecommendedCombos([], [{ id: "c1", name: "fast", models: ["x/y"] }]);
  assert.deepEqual(
    plan.map((item) => [item.name, item.action]),
    [
      ["default", "blocked"],
      ["fast", "blocked"],
      ["review", "blocked"],
    ]
  );
  assert.equal(plan[1].comboId, "c1");
  assert.match(plan[0].blockedReason ?? "", /No connected account/);
});

// --- adapter over the combo-builder catalog --------------------------------

const provider = (
  providerId: string,
  connections: CatalogProvider["connections"],
  models: string[],
  extra: Partial<CatalogProvider> = {}
): CatalogProvider => ({
  providerId,
  displayName: providerId.toUpperCase(),
  alias: providerId,
  connections,
  models: models.map((id) => ({ id, qualifiedModel: `${providerId}/${id}`, name: id })),
  ...extra,
});

test("only providers with an active connection the caller may use feed the recommendations", () => {
  const catalog = [
    provider("claude", [{ id: "c1", type: "oauth", isActive: true }], ["claude-opus-5"]),
    provider("openai", [{ id: "c2", type: "apikey", isActive: true }], ["gpt-6-sol"]),
    provider("gemini", [{ id: "c3", type: "apikey", isActive: false }], ["gemini-3.1-pro"]),
    provider("opencode", [], ["big-pickle"]), // no-auth catalog entry: not connected
  ];
  const all = connectedProviders(catalog);
  assert.deepEqual(
    all.map((c) => [c.identity.id, c.identity.subscription]),
    [
      ["claude", true],
      ["openai", false],
    ]
  );
  assert.deepEqual(
    toRecommendationModels(all).map((m) => m.id),
    ["claude/claude-opus-5", "openai/gpt-6-sol"]
  );

  // A key scoped to one connection (or to a fingerprint of it) sees only that account.
  const scoped = connectedProviders(catalog, { allowedConnectionIds: ["c2"] });
  assert.deepEqual(
    scoped.map((c) => c.identity.id),
    ["openai"]
  );
  const pinned = connectedProviders(
    [provider("claude", [{ id: "c1|fp|abc", type: "oauth", isActive: true }], ["claude-opus-5"])],
    { allowedConnectionIds: ["c1"] }
  );
  assert.equal(pinned.length, 1);
});

test("non-chat models are skipped, vision and subscription come from the injected classifiers", () => {
  const catalog = [
    provider("codex", [{ id: "c1", type: "apikey", isActive: true }], ["gpt-6-luna", "embedder"]),
  ];
  catalog[0].models[1].supportedEndpoints = ["embeddings"];
  catalog[0].models[0].supportedEndpoints = ["chat"];
  const connected = connectedProviders(catalog, { isSubscription: () => true });
  const models = toRecommendationModels(connected, { isVision: (id) => id === "gpt-6-luna" });
  assert.deepEqual(
    models.map((m) => [m.id, m.provider?.subscription, m.capabilities?.vision]),
    [["codex/gpt-6-luna", true, true]]
  );
  assert.equal(buildRecommendations(models).recommended.vision?.id, "codex/gpt-6-luna");
});

test("a reasoning-effort variant is not offered next to its base model", () => {
  const catalog = [
    provider(
      "anthropic",
      [{ id: "c1", type: "apikey", isActive: true }],
      ["claude-opus-5", "claude-opus-5-low", "gpt-5-codex-max", "orphan-high"]
    ),
  ];
  const models = toRecommendationModels(connectedProviders(catalog));
  assert.deepEqual(
    models.map((m) => m.id),
    ["anthropic/claude-opus-5", "anthropic/gpt-5-codex-max", "anthropic/orphan-high"]
  );
});

test("System One models are offered only for connected providers", () => {
  const connected = connectedProviders([
    provider("typesafe-ai", [{ id: "c1", type: "apikey", isActive: true }], []),
  ]);
  const systemOne = toSystemOneModels(
    [
      { id: "typesafe-ai/jev-latest", provider: "typesafe-ai", name: "JEV Latest" },
      { id: "other/jev-x", provider: "other" },
    ],
    connected
  );
  assert.deepEqual(
    systemOne.map((m) => m.id),
    ["typesafe-ai/jev-latest"]
  );
  assert.equal(
    buildRecommendations([], systemOne).recommended.systemone?.id,
    "typesafe-ai/jev-latest"
  );
});
