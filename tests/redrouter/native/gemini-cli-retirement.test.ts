import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimeModelProviderAvailable,
  isRuntimeProviderRetirementError,
} from "../../../src/shared/constants/providerRetirement.ts";

const thrown = (model: string): unknown => {
  try {
    assertRuntimeModelProviderAvailable(model);
  } catch (error) {
    return error;
  }
  return null;
};

test("a Gemini model asked for through the old gc/ prefix is answered with the retirement", () => {
  for (const model of ["gc/gemini-2.5-pro", "GC/gemini-3-flash", "gc/gemini-cli-thing"]) {
    const error = thrown(model);
    assert.ok(isRuntimeProviderRetirementError(error), model);
    assert.match((error as Error).message, /antigravity/);
  }
});

test("gc/ still reaches Grok Build for Grok models, and other prefixes are untouched", () => {
  assert.equal(thrown("gc/grok-4.7"), null);
  assert.equal(thrown("if/kimi-k2.7-code"), null);
  assert.equal(thrown("openai/gpt-5"), null);
  assert.equal(thrown("no-prefix-model"), null);
  assert.ok(isRuntimeProviderRetirementError(thrown("gemini-cli/anything")));
});
