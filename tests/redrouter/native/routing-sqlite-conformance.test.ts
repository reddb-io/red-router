import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { registerComboRepositoryConformance } from "../../helpers/persistence/comboRepositoryConformance.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-sqlite-contract-"));
process.env.DATA_DIR = dir;
delete process.env.RED_ROUTER_ROUTING_BACKEND;
delete process.env.RED_ROUTER_ROUTING_DATABASE_URL;
const core = await import("../../../src/lib/db/core.ts");
const { sqliteComboRepository: combos } =
  await import("../../../src/lib/db/repositories/sqliteComboRepository.ts");
const { sqliteModelComboMappingRepository: mappings } =
  await import("../../../src/lib/db/repositories/sqliteModelComboMappingRepository.ts");
const facade = await import("../../../src/lib/db/combos.ts");
async function reset() {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
registerComboRepositoryConformance(async () => ({
  combos,
  mappings,
  reset,
  async corruptComboPayload(id: string) {
    core.getDbInstance().prepare("UPDATE combos SET data = ? WHERE id = ?").run("", id);
  },
}));
test("default SQLite facade count is asynchronous", async () => {
  await reset();
  const count = facade.getCombosCount();
  assert.ok(count instanceof Promise);
  assert.equal(await count, 0);
  await facade.createCombo({ name: "counted", models: [] });
  assert.equal(await facade.getCombosCount(), 1);
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
