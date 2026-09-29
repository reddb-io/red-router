import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { updateProviderConnectionSchema } from "../../../src/shared/validation/schemas/provider.ts";

const read = (file: string) => readFileSync(file, "utf8");
const dir = "src/app/(dashboard)/dashboard/providers/[id]";

test("a connection can be renamed on its own, whatever else the edit form requires", () => {
  // The API takes a name-only update: no key, URL or other field has to accompany it.
  assert.equal(
    updateProviderConnectionSchema.safeParse({ name: "My custom endpoint" }).success,
    true
  );

  const hook = read(`${dir}/hooks/useProviderConnections.ts`);
  assert.match(hook, /const handleRenameConnection = async/);
  assert.match(hook, /body: JSON\.stringify\(\{ name: trimmed \}\)/);

  const panel = read(`${dir}/components/ConnectionsListPanel.tsx`);
  assert.equal(
    (panel.match(/onRename=\{\(name\) => handleRenameConnection\(conn\.id, name\)\}/g) ?? [])
      .length,
    2
  );

  const row = read(`${dir}/components/ConnectionRow.tsx`);
  assert.ok(row.includes("onRename?: (name: string) => Promise<void>"));
  assert.ok(row.includes('event.key === "Enter"'));
  assert.ok(row.includes('event.key === "Escape"'));
});
