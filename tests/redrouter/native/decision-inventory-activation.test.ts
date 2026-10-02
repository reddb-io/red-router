import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";
import { getModelEndpointDecision } from "../../../open-sse/services/modelEndpointPolicy.ts";
import { resolveSystemOneTarget } from "../../../open-sse/handlers/systemOneCore.ts";

const dir = mkdtempSync(join(tmpdir(), "redrouter-decision-inventory-"));
process.env.DATA_DIR = dir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
const core = await import("../../../src/lib/db/core.ts");
const models = await import("../../../src/lib/db/models.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { GET: inventory } = await import("../../../src/app/api/synced-available-models/route.ts");
const { PATCH: activate } = await import("../../../src/app/api/provider-models/route.ts");
const { GET: catalog } = await import("../../../src/app/api/v1/models/route.ts");
after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
async function ids(capability: string) {
  const response = await catalog(
    new Request(`http://localhost/v1/models?capabilities=${capability}`)
  );
  assert.equal(response.status, 200);
  return (await response.json()).data as Array<{
    id: string;
    type?: string;
    capabilities?: { decision?: boolean };
  }>;
}

test("management exposes JEV even when chat discovery omits it, and activation enables RedCode decision discovery", async () => {
  await updateSettings({ hideAutoCombos: true, hidePaidModels: false, requireLogin: false });
  const connection = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "fixture",
    isActive: true,
  });
  await models.replaceSyncedAvailableModelsForConnection("openrouter", String(connection.id), [
    { id: "vendor/chat" },
  ]);
  const response = await inventory(
    await makeManagementSessionRequest(
      "http://localhost/api/synced-available-models?provider=openrouter"
    )
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.models.map((model: { id: string }) => model.id),
    ["vendor/chat"]
  );
  assert.ok(body.decisionModels.some((model: { id: string }) => model.id === "typesafe/jev-1.13"));
  assert.deepEqual(await ids("decision"), [], "discovery does not activate JEV");
  const selected = await activate(
    await makeManagementSessionRequest("http://localhost/api/provider-models?provider=openrouter", {
      method: "PATCH",
      body: { modelIds: ["typesafe/jev-1.13"], isActive: true },
    })
  );
  assert.equal(selected.status, 200);
  const listed = await ids("decision");
  assert.ok(
    listed.some(
      (model) =>
        model.id === "openrouter/typesafe/jev-1.13" && model.capabilities?.decision === true
    )
  );
  assert.ok(!(await ids("chat")).some((model) => model.id.includes("jev-1.13")));
});

test("synced JEV versions retain the decision protocol while Jev Router remains chat", async () => {
  const connection = await providers.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    apiKey: "fixture-2",
    isActive: true,
  });
  await models.replaceSyncedAvailableModelsForConnection("openrouter", String(connection.id), [
    { id: "typesafe/jev-1.14.0", supportedEndpoints: ["chat"] },
    { id: "typesafe/jev-router", supportedEndpoints: ["chat"] },
  ]);
  await models.setModelActivation("openrouter", "typesafe/jev-1.14.0", true);
  await models.setModelActivation("openrouter", "typesafe/jev-router", true);
  assert.ok((await ids("decision")).some((model) => model.id === "openrouter/typesafe/jev-1.14.0"));
  assert.ok(!(await ids("decision")).some((model) => model.id.includes("jev-router")));
  assert.ok((await ids("chat")).some((model) => model.id === "openrouter/typesafe/jev-router"));
  assert.equal(getModelEndpointDecision("openrouter", "typesafe/jev-router").chatSelectable, true);
  assert.equal(resolveSystemOneTarget("openrouter/typesafe/jev-router"), null);
  assert.equal(
    resolveSystemOneTarget("openrouter/typesafe/jev-1.14.0")?.model,
    "typesafe/jev-1.14.0"
  );
  await models.setModelActivation("openrouter", "typesafe/jev-1.14.0", false);
  assert.ok(!(await ids("decision")).some((model) => model.id.endsWith("jev-1.14.0")));
});
