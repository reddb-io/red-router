import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// The route runs against the real catalog of a scratch install: two connected API-key
// accounts, no login required (a fresh install), so the management gate lets the call in.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-recommended-route-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { getCombos } = await import("../../../src/lib/db/combos.ts");
const route = await import("../../../src/app/api/combos/recommended/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const url = "http://localhost/api/combos/recommended";
const post = (body?: unknown) =>
  route.POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

test("GET with no account connected reports every role blocked", async () => {
  const response = await route.GET(new Request(url));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.recommended, { default: null, fast: null, review: null, systemone: null });
  assert.equal(body.blocked, 3);
  assert.equal(body.toCreate, 0);
});

test("GET previews and POST applies the recommended combos with Friday's response shape", async () => {
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    isActive: true,
    name: "OpenAI",
    apiKey: "sk-test-openai",
  });
  await createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    isActive: true,
    name: "Anthropic",
    apiKey: "sk-test-anthropic",
  });

  const { activateCatalogFixtureInventory } =
    await import("../../helpers/modelActivationFixtures.ts");
  await activateCatalogFixtureInventory();
  const preview = await (await route.GET(new Request(url))).json();
  assert.deepEqual(
    Object.keys(preview).sort(),
    ["blocked", "items", "recommended", "toCreate", "toUpdate", "unchanged"].sort()
  );
  assert.equal(preview.toCreate, 3);
  assert.deepEqual(
    preview.items.map((item: { name: string; action: string }) => [item.name, item.action]),
    [
      ["default", "create"],
      ["fast", "create"],
      ["review", "create"],
    ]
  );
  assert.ok(preview.recommended.default.id.includes("/"));
  assert.deepEqual(await getCombos(), []);

  const applied = await (await post({})).json();
  assert.equal(applied.createdCount, 3);
  assert.equal(applied.updatedCount, 0);
  assert.deepEqual(
    applied.created.map((combo: { name: string }) => combo.name),
    ["default", "fast", "review"]
  );
  assert.deepEqual(applied.unchanged, []);
  assert.deepEqual(applied.skipped, []);

  // Idempotent: the second apply changes nothing and the preview agrees.
  const again = await (await post()).json();
  assert.equal(again.createdCount, 0);
  assert.equal(again.updatedCount, 0);
  assert.deepEqual(again.unchanged, ["default", "fast", "review"]);
  assert.equal((await getCombos()).length, 3);
  const settled = await (await route.GET(new Request(url))).json();
  assert.equal(settled.unchanged, 3);
});

test("POST validates its body and never leaks internals", async () => {
  const response = await post({ names: "default" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(typeof body.error === "string" || typeof body.error === "object", true);
  assert.equal(JSON.stringify(body).includes("at /"), false);

  const limited = await (await post({ names: ["fast"] })).json();
  assert.deepEqual(
    limited.items.map((item: { name: string }) => item.name),
    ["fast"]
  );
});
