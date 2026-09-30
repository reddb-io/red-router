import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCatalogDisplayName,
  normalizeCatalogModelNames,
} from "../../../src/app/api/v1/models/displayNames.ts";

test("vendor prefixes copied from OpenRouter are dropped", () => {
  assert.equal(normalizeCatalogDisplayName("Z.ai: GLM 5.3", "openrouter/z-ai/glm-5.3"), "GLM 5.3");
  assert.equal(normalizeCatalogDisplayName("Z.ai: GLM 5.3 (batch)"), "GLM 5.3 (batch)");
  assert.equal(normalizeCatalogDisplayName("Xiaomi: MiMo-V2.5-Pro"), "MiMo-V2.5-Pro");
});

test("names that are really ids are humanized", () => {
  assert.equal(
    normalizeCatalogDisplayName("z-ai/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash"),
    "GLM 5.3 Flash"
  );
  assert.equal(normalizeCatalogDisplayName("gpt-5.5", "cx/gpt-5.5"), "GPT-5.5");
});

test("already-clean names are untouched", () => {
  assert.equal(normalizeCatalogDisplayName("GLM 5.3", "opencode-go/glm-5.3"), "GLM 5.3");
  assert.equal(normalizeCatalogDisplayName("GLM 5.3 Flash (Vision)"), "GLM 5.3 Flash (Vision)");
});

test("a long label before a colon is real name text, not a vendor", () => {
  const name = "A very long descriptive label that is not a vendor: tail";
  assert.equal(normalizeCatalogDisplayName(name), name);
});

test("only name changes; entries without a name pass through", () => {
  const models = [
    { id: "openrouter/z-ai/glm-5.3", name: "Z.ai: GLM 5.3", owned_by: "openrouter" },
    { id: "x/y" },
  ];
  const out = normalizeCatalogModelNames(models);
  assert.deepEqual(out[0], { id: "openrouter/z-ai/glm-5.3", name: "GLM 5.3", owned_by: "openrouter" });
  assert.equal(out[1], models[1]);
});
