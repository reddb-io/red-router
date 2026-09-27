import assert from "node:assert/strict";
import test from "node:test";

import { compatibilityAliasMap, providerId } from "../../scripts/ad-hoc/providerInventoryParse.mjs";

test("inventory reads RegistryEntry id after model declarations", () => {
  const source = `
    const MODELS = [{ id: "wrong-model" }];
    export const codingPlanProvider: RegistryEntry = {
      id: "volcengine-coding-plan",
      models: MODELS,
    };
  `;
  assert.equal(
    providerId(source, "open-sse/config/providers/registry/volcengine/coding-plan/index.ts"),
    "volcengine-coding-plan"
  );
  assert.equal(
    providerId(
      'export const seekaiProvider = buildOpenAiCompatibleRegistryEntry({ id: "seekai" });',
      "open-sse/config/providers/registry/seekai/index.ts"
    ),
    "seekai"
  );
  assert.equal(
    providerId(
      'export const MAGNIFIC_IMAGE_PROVIDER = { id: "magnific" };',
      "open-sse/config/providers/registry/magnific/index.ts"
    ),
    null
  );
  assert.equal(
    providerId('export default { id: "volcengine-ark" };', "upstream/ark.js"),
    "volcengine-ark"
  );
});

test("inventory resolves explicit aliases only when their target exists", () => {
  const file = "src/shared/constants/providerCompatibilityAliases.ts";
  const source = `export const PROVIDER_COMPATIBILITY_ALIASES = {
    "volcengine-ark": "volcengine-coding-plan",
    ark: "volcengine-coding-plan",
  } as const;`;
  const providers = new Map([["volcengine-coding-plan", "registry/ark/index.ts"]]);
  const aliases = compatibilityAliasMap(source, file, providers);
  assert.deepEqual(aliases.get("volcengine-ark"), { id: "volcengine-coding-plan", file });
  assert.deepEqual(aliases.get("ark"), { id: "volcengine-coding-plan", file });
  assert.throws(() => compatibilityAliasMap(source, file, new Map()), /missing provider/);
});
