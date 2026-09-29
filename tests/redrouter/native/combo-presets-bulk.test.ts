import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Real combo DB on a scratch install with no login, so the management gate lets the calls in.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-combo-presets-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const { buildComboPresets } = await import("../../../src/lib/comboPresets.ts");
const presetsRoute = await import("../../../src/app/api/combos/presets/route.ts");
const bulkRoute = await import("../../../src/app/api/combos/bulk/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (route: { POST: (request: Request) => Promise<Response> }, path: string, body: unknown) =>
  route.POST(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("Claude presets map each client-native id to its cc/ model and never repeat a name", () => {
  const items = buildComboPresets("claude");
  assert.ok(items.length > 0);
  assert.equal(new Set(items.map((item) => item.name)).size, items.length);
  for (const item of items) {
    assert.match(item.name, /^[a-zA-Z0-9_.-]+$/);
    assert.equal(item.models.length, 1);
    assert.equal(item.exists, false);
  }
  assert.ok(items.some((item) => item.models[0].startsWith("cc/")));
});

test("presets mark names that already exist, ignoring case", () => {
  const first = buildComboPresets("claude")[0];
  const again = buildComboPresets("claude", [first.name.toUpperCase()]);
  assert.equal(again.find((item) => item.name === first.name)?.exists, true);
});

test("applying presets creates only the missing combos and is safe to repeat", async () => {
  const preview = await (
    await presetsRoute.GET(new Request("http://localhost/api/combos/presets?source=claude"))
  ).json();
  assert.ok(preview.toCreate > 0);

  const target = preview.items[0].name;
  await combosDb.createCombo({ name: target, models: ["cc/anything"] });

  const applied = await (
    await post(presetsRoute, "/api/combos/presets", { source: "claude" })
  ).json();
  assert.ok(!applied.created.includes(target), "an existing combo is never overwritten");
  assert.equal(applied.createdCount, applied.created.length);
  const stored = (await combosDb.getCombos()).find((combo) => combo.name === target);
  assert.equal(JSON.stringify(stored?.models).includes("cc/anything"), true);

  const second = await (await post(presetsRoute, "/api/combos/presets", { source: "claude" })).json();
  assert.equal(second.createdCount, 0);
});

test("an unknown preset source is a 400", async () => {
  const response = await presetsRoute.GET(
    new Request("http://localhost/api/combos/presets?source=vim")
  );
  assert.equal(response.status, 400);
  assert.equal((await post(presetsRoute, "/api/combos/presets", { source: "vim" })).status, 400);
});

test("bulk delete and strategy change report each combo on its own", async () => {
  const a = await combosDb.createCombo({ name: "bulk-a", models: ["cc/x"] });
  const b = await combosDb.createCombo({ name: "bulk-b", models: ["cc/y"] });

  const changed = await (
    await post(bulkRoute, "/api/combos/bulk", {
      action: "setStrategy",
      ids: [a.id, b.id, "missing-id"],
      strategy: "round-robin",
    })
  ).json();
  assert.equal(changed.succeeded, 2);
  assert.equal(changed.results.find((r: { id: string }) => r.id === "missing-id").status, "not_found");
  assert.equal((await combosDb.getComboById(a.id as string))?.strategy, "round-robin");

  const deleted = await (
    await post(bulkRoute, "/api/combos/bulk", { action: "delete", ids: [a.id, b.id] })
  ).json();
  assert.equal(deleted.succeeded, 2);
  assert.equal(await combosDb.getComboById(a.id as string), null);
});

test("bulk rejects bad input and quota-share combos are left alone", async () => {
  assert.equal((await post(bulkRoute, "/api/combos/bulk", { action: "delete", ids: [] })).status, 400);
  assert.equal(
    (await post(bulkRoute, "/api/combos/bulk", { action: "setStrategy", ids: ["x"], strategy: "nope" }))
      .status,
    400
  );
  const quota = await combosDb.createCombo({ name: "qtSd/pool", models: ["cc/x"] });
  const result = await (
    await post(bulkRoute, "/api/combos/bulk", { action: "delete", ids: [quota.id] })
  ).json();
  assert.equal(result.results[0].status, "skipped");
  assert.ok(await combosDb.getComboById(quota.id as string));
});
