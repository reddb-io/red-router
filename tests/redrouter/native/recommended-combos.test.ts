import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The recommended setup writes combos through the real combo DB module (so the combo
// invariants and step normalization apply); only the connected-account catalog is a fixture.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-recommended-combos-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const { applyRecommendedCombos, previewRecommendedCombos, summarizeRecommendedItems } =
  await import("../../../src/lib/recommendedCombos.ts");
import type {
  RecommendationCatalog,
  RecommendedCombosDeps,
} from "../../../src/lib/recommendedCombos.ts";

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const claudeCode = { id: "claude", slug: "claude", name: "Claude Code", subscription: true };
const codex = { id: "codex", slug: "codex", name: "OpenAI Codex", subscription: true };
const anthropic = { id: "anthropic", slug: "anthropic", name: "Anthropic", subscription: false };

let catalog: RecommendationCatalog = { models: [], systemOne: [] };
const model = (provider: typeof codex, id: string, extra = {}) => ({
  id: `${provider.slug}/${id}`,
  name: id,
  provider,
  ...extra,
});

const deps: RecommendedCombosDeps = {
  loadCatalog: async () => catalog,
  listCombos: async () => await combosDb.getCombos(),
  createCombo: async (data) => await combosDb.createCombo(data),
  updateCombo: async (id, data) => await combosDb.updateCombo(id, data),
};

const namesOf = async (name: string) =>
  (await combosDb.getCombos()).filter((combo) => combo.name === name);
const memberIds = (combo: { models?: unknown }) =>
  (combo.models as Array<{ model: string }>).map((step) => step.model);

test("nothing connected: every role is blocked and no combo is written", async () => {
  const preview = await previewRecommendedCombos({}, deps);
  assert.deepEqual(
    preview.items.map((item) => [item.name, item.action]),
    [
      ["default", "blocked"],
      ["fast", "blocked"],
      ["review", "blocked"],
    ]
  );
  assert.deepEqual(summarizeRecommendedItems(preview.items), {
    toCreate: 0,
    toUpdate: 0,
    unchanged: 0,
    blocked: 3,
  });
  const applied = await applyRecommendedCombos({}, null, deps);
  assert.deepEqual(applied.skipped, ["default", "fast", "review"]);
  assert.deepEqual(applied.created, []);
  assert.deepEqual(await combosDb.getCombos(), []);
});

test("preview reports what apply would create without writing anything", async () => {
  catalog = {
    models: [
      model(claudeCode, "claude-opus-5"),
      model(claudeCode, "claude-haiku-4-5"),
      model(codex, "gpt-6-luna"),
      model(codex, "gpt-5.5"),
    ],
    systemOne: [],
  };
  const preview = await previewRecommendedCombos({}, deps);
  assert.deepEqual(
    preview.items.map((item) => [item.name, item.action, item.models]),
    [
      ["default", "create", ["claude/claude-opus-5", "codex/gpt-5.5"]],
      ["fast", "create", ["codex/gpt-6-luna", "claude/claude-haiku-4-5"]],
      ["review", "create", ["claude/claude-opus-5", "codex/gpt-5.5"]],
    ]
  );
  assert.equal(preview.recommended.default?.id, "claude/claude-opus-5");
  assert.deepEqual(await combosDb.getCombos(), []);
});

test("apply creates them once; applying again changes nothing", async () => {
  const first = await applyRecommendedCombos({}, null, deps);
  assert.deepEqual(
    first.created.map((combo) => combo.name),
    ["default", "fast", "review"]
  );

  const second = await applyRecommendedCombos({}, null, deps);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.unchanged, ["default", "fast", "review"]);
  assert.deepEqual((await combosDb.getCombos()).map((combo) => combo.name).sort(), [
    "default",
    "fast",
    "review",
  ]);
});

test("an existing combo of the same name is updated in place", async () => {
  const [fast] = await namesOf("fast");
  await combosDb.updateCombo(String(fast.id), { models: ["cc/claude-haiku-4-5"] });

  const preview = await previewRecommendedCombos({}, deps);
  const item = preview.items.find((candidate) => candidate.name === "fast");
  assert.equal(item?.action, "update");
  assert.equal(item?.comboId, fast.id);
  assert.deepEqual(item?.current, ["cc/claude-haiku-4-5"]);

  const result = await applyRecommendedCombos({}, null, deps);
  assert.deepEqual(
    result.updated.map((combo) => combo.id),
    [fast.id]
  );
  const after = await namesOf("fast");
  assert.equal(after.length, 1);
  assert.deepEqual(memberIds(after[0]), ["codex/gpt-6-luna", "claude/claude-haiku-4-5"]);
});

test("a newly connected provider updates only the selected combos", async () => {
  catalog = { ...catalog, models: [model(anthropic, "claude-opus-5-5"), ...catalog.models] };
  const preview = await previewRecommendedCombos({}, deps);
  const item = preview.items.find((candidate) => candidate.name === "default");
  assert.equal(item?.action, "update");
  assert.deepEqual(item?.models, [
    "anthropic/claude-opus-5-5",
    "claude/claude-opus-5",
    "codex/gpt-5.5",
  ]);

  const result = await applyRecommendedCombos({}, ["review"], deps);
  assert.deepEqual(
    result.items.map((candidate) => candidate.name),
    ["review"]
  );
  assert.deepEqual(memberIds((await namesOf("default"))[0]), [
    "claude/claude-opus-5",
    "codex/gpt-5.5",
  ]);

  await applyRecommendedCombos({}, ["default"], deps);
  const defaults = await namesOf("default");
  assert.equal(defaults.length, 1);
  assert.equal(memberIds(defaults[0])[0], "anthropic/claude-opus-5-5");
});
