import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-clear-catalog-"));
process.env.DATA_DIR = dir;
process.env.INITIAL_PASSWORD = "";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const models = await import("../../../src/lib/db/models.ts");
const { DELETE } = await import("../../../src/app/api/provider-models/route.ts");
after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("clear removes stored models and revokes opt-ins that a future sync could restore", async () => {
  await updateSettings({ requireLogin: false });
  await models.addCustomModel("codex", "manual-model", "Manual");
  await models.replaceSyncedAvailableModelsForConnection("codex", "connection-a", [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  ]);
  for (const id of ["gpt-6-sol", "gpt-6.1-sol", "manual-model"])
    await models.setModelActivation("codex", id, true);
  await models.setModelActivation("openrouter", "other", true);
  const response = await DELETE(
    new Request("http://localhost/api/provider-models?provider=codex&all=true")
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await models.getCustomModels("codex"), []);
  assert.deepEqual(await models.getSyncedAvailableModels("codex"), []);
  for (const id of ["gpt-6-sol", "gpt-6.1-sol", "manual-model"])
    assert.equal(models.getModelIsHidden("codex", id), true);
  await models.replaceSyncedAvailableModelsForConnection("codex", "connection-a", [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  ]);
  assert.equal(models.getModelIsHidden("codex", "gpt-6.1-sol"), true);
  assert.equal(models.getModelIsHidden("openrouter", "other"), false);
});
