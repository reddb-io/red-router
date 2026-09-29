import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupReadiness } from "../../../src/lib/setup/readiness.ts";

test("setup requires a tested active provider and an active key", () => {
  const ready = buildSetupReadiness({
    connectionName: "Example",
    connectionActive: true,
    providerValid: true,
    hasActiveKey: true,
  });
  assert.equal(ready.status, "ready");
  assert.deepEqual(
    ready.checks.map((check) => check.id),
    ["server", "provider", "apiKey"]
  );

  const missingKey = buildSetupReadiness({
    connectionActive: true,
    providerValid: true,
    hasActiveKey: false,
  });
  assert.equal(missingKey.status, "action_required");
  assert.equal(missingKey.checks[2].status, "fail");

  const inactive = buildSetupReadiness({
    connectionActive: false,
    providerValid: true,
    hasActiveKey: true,
  });
  assert.equal(inactive.status, "action_required");
  assert.equal(inactive.checks[1].status, "fail");
});
