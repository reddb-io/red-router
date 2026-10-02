import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCompatibleModelId } from "../../../open-sse/services/compatibleModelIdentity.ts";
import { projectConnectionModels } from "../../../src/lib/providerModels/selection.ts";

const directory = mkdtempSync(join(tmpdir(), "redrouter-native-identity-"));
process.env.DATA_DIR = directory;
const providers = await import("../../../src/lib/db/providers.ts");
const models = await import("../../../src/lib/db/models.ts");
const { normalizeDiscoveredModels } =
  await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { normalizeSyncedAvailableModels } = await import("../../../src/lib/db/models/synced.ts");
const { getModelInfo } = await import("../../../src/sse/services/model.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("declared native namespaces win over matching local prefix, including chained routers and tilde", () => {
  const cases = [
    ["karavela/glm-5.3-flash", ["karavela", "node-id"]],
    ["red/openrouter/~typesafe/jev-latest", ["red", "node-id"]],
    ["node-id/mimo-pro", ["karavela", "node-id"]],
  ] as const;
  for (const [native, prefixes] of cases) {
    assert.equal(normalizeCompatibleModelId(native, prefixes, new Set([native])), native);
  }
  const projected = projectConnectionModels(
    "node-id",
    "karavela",
    [
      {
        id: "karavela/glm-5.3-flash",
        nativeModelId: "karavela/glm-5.3-flash",
        supportedEndpoints: ["chat"],
      },
    ],
    ["chat"]
  );
  assert.equal(projected[0].id, "karavela/glm-5.3-flash");
  assert.equal(projected[0].fullModel, "karavela/karavela/glm-5.3-flash");
  assert.equal(
    projectConnectionModels(
      "node-id",
      "karavela",
      [{ id: "karavela/legacy", supportedEndpoints: ["chat"] }],
      ["chat"]
    )[0].fullModel,
    "karavela/legacy"
  );
});

test("legacy duplicate routing recovers only a unique exact declared ID; unknown and ambiguous routes remain literal", () => {
  const prefixes = ["karavela", "node-id"];
  assert.equal(
    normalizeCompatibleModelId("node-id/karavela/mimo-pro", prefixes, new Set(["mimo-pro"])),
    "mimo-pro"
  );
  assert.equal(
    normalizeCompatibleModelId("karavela/mimo-pro", prefixes, new Set()),
    "karavela/mimo-pro"
  );
  assert.equal(
    normalizeCompatibleModelId(
      "node-id/karavela/mimo-pro",
      prefixes,
      new Set(["karavela/mimo-pro", "mimo-pro"])
    ),
    "node-id/karavela/mimo-pro"
  );
});

test("upstream extra nativeModelId cannot rewrite its advertised wire ID or erase the local hop", () => {
  const [model] = normalizeDiscoveredModels(
    [
      {
        id: "karavela/glm-5.3-flash",
        nativeModelId: "glm-5.3-flash",
        supportedEndpoints: ["chat"],
      },
    ],
    "compatible-fixture"
  );
  assert.equal(model.nativeModelId, model.id);
  const [selection] = projectConnectionModels("compatible-fixture", "karavela", [model], ["chat"]);
  assert.equal(selection.id, "karavela/glm-5.3-flash");
  assert.equal(selection.fullModel, "karavela/karavela/glm-5.3-flash");
  const [legacySnapshot] = normalizeSyncedAvailableModels([
    { ...model, nativeModelId: "glm-5.3-flash" },
  ]);
  assert.equal(legacySnapshot.nativeModelId, "karavela/glm-5.3-flash");
});

test("actual compatible-node resolver returns exact discovered native ID and uniquely recovers old duplicates", async () => {
  const node = await providers.createProviderNode({
    id: "compatible-fixture",
    type: "openai-compatible",
    prefix: "karavela",
    name: "Karavela",
    baseUrl: "https://compatible.example/v1",
  });
  const id = String(node.id);
  const connection = await providers.createProviderConnection({
    provider: id,
    authType: "apikey",
    apiKey: "compatible-upstream-key",
    isActive: true,
  });
  await models.replaceSyncedAvailableModelsForConnection(id, String(connection.id), [
    {
      id: "karavela/glm-5.3-flash",
      nativeModelId: "glm-5.3-flash",
      name: "GLM",
      source: "imported",
      supportedEndpoints: ["chat"],
    },
    { id: "mimo-pro", name: "Mimo", source: "imported", supportedEndpoints: ["chat"] },
  ]);
  await models.setModelActivation(id, "karavela/glm-5.3-flash", true);
  await models.setModelActivation(id, "mimo-pro", true);
  const native = await getModelInfo("karavela/karavela/glm-5.3-flash");
  assert.equal(native.provider, id);
  assert.equal(native.model, "karavela/glm-5.3-flash");
  const legacy = await getModelInfo(`${id}/${id}/mimo-pro`);
  assert.equal(legacy.provider, id);
  assert.equal(legacy.model, "mimo-pro");
});
