// The dashboard's recommended setup creates default/fast/review combos from the
// connected providers, and re-running it updates them in place instead of duplicating.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let recommended;

const connect = (provider, enabledModels) =>
  db.createProviderConnection({ provider, authType: "apikey", name: provider, apiKey: `k-${provider}`, providerSpecificData: { enabledModels } });
const combosNamed = async (name) => (await db.getCombos()).filter((combo) => combo.name === name);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-recommended-combos-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  recommended = await import("@/lib/recommendedCombos.js");
  await connect("claude", ["claude-opus-5", "claude-haiku-4-5"]);
  await connect("codex", ["gpt-6-luna", "gpt-5.5", "gpt-5.5-review"]);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("recommended setup combos", () => {
  it("previews the combos it would create from the connected providers", async () => {
    const preview = await recommended.previewRecommendedCombos({});
    expect(preview.items.map((item) => [item.name, item.action, item.models])).toEqual([
      ["default", "create", ["claude-code/claude-opus-5", "codex/gpt-5.5"]],
      ["fast", "create", ["codex/gpt-6-luna", "claude-code/claude-haiku-4-5"]],
      ["review", "create", ["codex/gpt-5.5-review"]],
    ]);
    expect(preview.recommended.default.id).toBe("claude-code/claude-opus-5");
    expect(await db.getCombos()).toEqual([]);
  });

  it("creates them once; applying again changes nothing", async () => {
    const first = await recommended.applyRecommendedCombos({});
    expect(first.created.map((combo) => combo.name)).toEqual(["default", "fast", "review"]);

    const second = await recommended.applyRecommendedCombos({});
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual(["default", "fast", "review"]);
    expect((await db.getCombos()).map((combo) => combo.name).sort()).toEqual(["default", "fast", "review"]);
  });

  it("updates an existing combo of the same name in place", async () => {
    const [fast] = await combosNamed("fast");
    await db.updateCombo(fast.id, { models: ["cc/claude-haiku-4-5"] });

    const preview = await recommended.previewRecommendedCombos({});
    expect(preview.items.find((item) => item.name === "fast")).toMatchObject({ action: "update", comboId: fast.id, current: ["cc/claude-haiku-4-5"] });

    const result = await recommended.applyRecommendedCombos({});
    expect(result.updated.map((combo) => combo.id)).toEqual([fast.id]);
    const after = await combosNamed("fast");
    expect(after).toHaveLength(1);
    expect(after[0].models).toEqual(["codex/gpt-6-luna", "claude-code/claude-haiku-4-5"]);
  });

  it("follows a newly connected provider and only touches the selected combos", async () => {
    await connect("anthropic", ["claude-opus-5-5"]);
    const preview = await recommended.previewRecommendedCombos({});
    expect(preview.items.find((item) => item.name === "default")).toMatchObject({
      action: "update",
      models: ["anthropic/claude-opus-5-5", "claude-code/claude-opus-5", "codex/gpt-5.5"],
    });

    const result = await recommended.applyRecommendedCombos({}, ["review"]);
    expect(result.items.map((item) => item.name)).toEqual(["review"]);
    expect(result.updated).toEqual([]);
    expect((await combosNamed("default"))[0].models).toEqual(["claude-code/claude-opus-5", "codex/gpt-5.5"]);

    await recommended.applyRecommendedCombos({}, ["default"]);
    const defaults = await combosNamed("default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].models[0]).toBe("anthropic/claude-opus-5-5");
  });
});
