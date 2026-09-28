import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pagePath = fileURLToPath(
  new URL(
    "../../src/app/(dashboard)/dashboard/providers/[id]/ProviderDetailPageClient.tsx",
    import.meta.url
  )
);

test("provider details put connections and models before advanced node settings", () => {
  const page = readFileSync(pagePath, "utf8");
  const connections = page.indexOf("<ConnectionsHeaderToolbar");
  const models = page.indexOf("<ProviderModelsSection");
  const advanced = page.indexOf("<CompatibleNodeCard");

  assert.ok(connections >= 0, "connections section exists");
  assert.ok(models > connections, "models follow connections");
  assert.ok(advanced > models, "advanced node settings follow models");
});
