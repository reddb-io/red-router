import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupReadiness } from "../../../src/lib/setup/readiness.ts";
import {
  validateSetupSelection,
  type SetupValidationDependencies,
} from "../../../src/lib/setup/validateSelection.ts";
import {
  readSetupProgress,
  writeSetupProgress,
  selectionFingerprint,
} from "../../../src/lib/setup/progress.ts";

const selection = {
  connectionId: "account",
  model: "openrouter/example/chat",
  apiKeyId: "chosen-key",
  apiKey: "secret",
};
function fixture(overrides: Partial<SetupValidationDependencies> = {}) {
  let discovered = false;
  const deps: SetupValidationDependencies = {
    connection: async () => ({ isActive: true, displayName: "Account" }),
    metadata: async () => ({
      id: "chosen-key",
      isActive: true,
      isBanned: false,
      allowedConnections: ["account"],
      allowedEndpoints: ["chat"],
    }),
    validKey: async () => true,
    modelAllowed: async () => true,
    models: async () => {
      discovered = true;
      return [{ fullModel: selection.model }];
    },
    ...overrides,
  };
  return { deps, discovered: () => discovered };
}

test("configuration readiness does not claim inference success", async () => {
  const { deps } = fixture();
  const result = await validateSetupSelection(selection, deps);
  assert.equal(result.status, "ready");
  assert.equal(result.inferenceTested, false);
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["server", "provider", "apiKey", "model"]
  );
});

test("a different valid key cannot satisfy the chosen key's check", async () => {
  const { deps, discovered } = fixture();
  const result = await validateSetupSelection({ ...selection, apiKeyId: "another-key" }, deps);
  assert.equal(result.status, "action_required");
  assert.equal(result.checks.find((check) => check.id === "apiKey")?.status, "fail");
  assert.equal(discovered(), false);
});

test("tenant policy narrowing prevents discovery of an unauthorized connection", async () => {
  const { deps, discovered } = fixture();
  const result = await validateSetupSelection({ ...selection, connectionId: "other-tenant" }, deps);
  assert.equal(result.checks.find((check) => check.id === "provider")?.status, "fail");
  assert.equal(discovered(), false);
});

test("unlisted models, blocked models, and endpoint restrictions cannot pass readiness", async () => {
  for (const override of [
    { models: async () => [{ fullModel: "openrouter/other" }] },
    { modelAllowed: async () => false },
    {
      metadata: async () => ({
        id: "chosen-key",
        isActive: true,
        isBanned: false,
        allowedConnections: [],
        allowedEndpoints: ["decisions"],
      }),
    },
    { validKey: async () => false },
    { connection: async () => ({ isActive: false }) },
  ]) {
    const { deps } = fixture(override);
    assert.equal((await validateSetupSelection(selection, deps)).status, "action_required");
  }
});

test("missing state fails closed", () => {
  assert.equal(
    buildSetupReadiness({
      connectionActive: false,
      connectionAllowed: false,
      keyValid: false,
      modelAvailable: false,
      modelAllowed: false,
      endpointAllowed: false,
    }).status,
    "action_required"
  );
});

test("setup progress persists only a sanitized selection and actions", () => {
  let stored = "";
  const storage = {
    setItem: (_key: string, value: string) => {
      stored = value;
    },
    getItem: () => stored,
  };
  const fingerprint = selectionFingerprint(selection, "https://router.example");
  const progress = {
    ...selection,
    copiedSelection: fingerprint,
    organized: true,
    validation: "ready",
  };
  writeSetupProgress(storage, progress);
  assert.ok(!stored.includes("secret"));
  assert.ok(!stored.includes("validation"));
  assert.equal(readSetupProgress(storage)?.copiedSelection, fingerprint);
  assert.notEqual(
    selectionFingerprint({ ...selection, model: "different" }, "https://router.example"),
    fingerprint
  );
  assert.equal(readSetupProgress({ getItem: () => "invalid" }), null);
  assert.doesNotThrow(() =>
    writeSetupProgress(
      {
        setItem: () => {
          throw new Error("blocked");
        },
      },
      progress
    )
  );
});
