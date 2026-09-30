import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  filterCatalogCapabilities,
  parseCatalogCapabilities,
  withCatalogRoleCapabilities,
} from "../../../src/app/api/v1/models/catalogCapabilities.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-catalog-capabilities-"));
process.env.DATA_DIR = dir;
const core = await import("../../../src/lib/db/core.ts");
const { finalizeCatalogResponse } =
  await import("../../../src/app/api/v1/models/catalogResponse.ts");
const { resolveCachedCatalogResponse, __resetCatalogBuilderRunsForTest } =
  await import("../../../src/app/api/v1/models/catalogCache.ts");

test.after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

const models = [
  {
    id: "openai/gpt-4o",
    owned_by: "openai",
    type: "chat",
    capabilities: { tool_calling: true, vision: true, reasoning: true },
  },
  {
    id: "openrouter/typesafe/jev-1.13",
    owned_by: "openrouter",
    root: "typesafe/jev-1.13",
    type: "systemone",
    capabilities: { tool_calling: true, reasoning: true, vision: true, effort_tiers: ["high"] },
  },
  { id: "openai/text-embedding-3-small", owned_by: "openai", type: "embedding" },
];

test("decision protocol overrides optimistic chat flags and preserves generation capabilities", () => {
  const catalog = models.map(withCatalogRoleCapabilities);
  const decision = catalog[1];
  assert.equal(decision.type, "systemone");
  assert.deepEqual(decision.supported_endpoints, ["systemone", "decisions"]);
  assert.deepEqual(
    filterCatalogCapabilities(catalog, ["decision"]).map((m) => m.id),
    [decision.id]
  );
  assert.deepEqual(
    filterCatalogCapabilities(catalog, ["chat", "tools", "vision", "reasoning"]).map((m) => m.id),
    [models[0].id]
  );
  assert.equal((decision.capabilities as Record<string, unknown>).effort_tiers, undefined);
  assert.equal(models[1].capabilities?.tool_calling, true, "the source must not be mutated");
  assert.deepEqual(filterCatalogCapabilities(catalog, ["decision", "tools"]), []);
  assert.deepEqual(filterCatalogCapabilities(catalog, ["structured-output"]), []);
});

test("explicit decision endpoints are recognized even without a catalog type", () => {
  const model = withCatalogRoleCapabilities({
    id: "gateway/jev",
    supported_endpoints: ["decisions"],
    capabilities: { reasoning: true },
  });
  assert.equal(model.type, "systemone");
  assert.equal((model.capabilities as Record<string, unknown>).chat, false);
  const known = withCatalogRoleCapabilities({
    id: "openrouter/typesafe/jev-1.13",
    owned_by: "openrouter",
    supported_endpoints: ["chat"],
  });
  assert.equal((known.capabilities as Record<string, unknown>).decision, true);
  const embedding = withCatalogRoleCapabilities({
    id: "openai/text-embedding-3-small",
    owned_by: "openai",
    supported_endpoints: ["chat"],
  });
  assert.deepEqual(filterCatalogCapabilities([embedding], ["chat"]), []);
  const combo = withCatalogRoleCapabilities({ id: "unknown-router", owned_by: "combo" });
  assert.equal("capabilities" in combo, false);
  assert.deepEqual(filterCatalogCapabilities([combo], ["chat"]), [combo]);
});

test("capability filters accept conjunctions and reject unknown or empty capabilities", () => {
  const parse = (query: string) =>
    parseCatalogCapabilities(new Request(`http://localhost/v1/models${query}`));
  assert.deepEqual(parse("?capabilities=chat,tools&capabilities=vision").data, [
    "chat",
    "tools",
    "vision",
  ]);
  assert.deepEqual(parse("").data, []);
  assert.equal(parse("?capabilities=").success, false);
  assert.equal(parse("?capabilities=unknown").success, false);
});

test("the serialized catalog filters decisions before applying OpenAI pagination", async () => {
  const response = await finalizeCatalogResponse(
    new Request("http://localhost/v1/models?capabilities=decision&limit=1"),
    models,
    () => undefined,
    {}
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.has_more, false);
  assert.deepEqual(
    body.data.map((model: { id: string }) => model.id),
    [models[1].id]
  );
  assert.equal(body.data[0].capabilities.tool_calling, false);
  assert.equal(body.data[0].capabilities.reasoning, false);
});

test("cached decision discovery never replaces the S2 list, and filtering cannot expand a scoped catalog", async () => {
  __resetCatalogBuilderRunsForTest();
  let builds = 0;
  async function list(query: string) {
    const response = await resolveCachedCatalogResponse(
      new Request(`http://localhost/v1/models${query}`),
      { corsHeaders: {}, diagnosticHeaders: {} },
      async (request) => {
        builds++;
        const response = await finalizeCatalogResponse(request, models, () => undefined, {});
        return {
          body: await response.text(),
          headers: {},
          status: response.status,
          cacheTTL: 60_000,
        };
      }
    );
    return (await response.json()).data.map((model: { id: string }) => model.id);
  }
  assert.deepEqual(await list("?capabilities=decision"), [models[1].id]);
  assert.deepEqual(await list("?capabilities=chat"), [models[0].id]);
  assert.deepEqual(await list("?capabilities=decision"), [models[1].id]);
  assert.equal(builds, 2);
  const scoped = [models[0]].map(withCatalogRoleCapabilities);
  assert.deepEqual(filterCatalogCapabilities(scoped, ["decision"]), []);
});
