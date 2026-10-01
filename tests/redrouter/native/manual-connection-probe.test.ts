import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConnectionTestDraft,
  providerConnectionTestBodySchema,
  isReadOnlyConnectionProbe,
  canRecoverManualProbe,
} from "../../../src/app/api/providers/[id]/test/manualProbe.ts";

test("draft probing uses edits, preserves a blank replacement key and leaves the saved object intact", () => {
  const saved = {
    apiKey: "saved-key",
    providerSpecificData: {
      baseUrl: "http://old/v1",
      validationModelId: "old-model",
      customHeader: "keep",
    },
  };
  const before = structuredClone(saved);
  const draft = providerConnectionTestBodySchema.parse({
    draft: { baseUrl: "http://10.101.2.111:25050/v1", apiKey: "", validationModelId: "" },
  }).draft;
  const probe = applyConnectionTestDraft(saved, draft);
  assert.equal(probe.apiKey, "saved-key");
  assert.equal(probe.providerSpecificData.baseUrl, "http://10.101.2.111:25050/v1");
  assert.equal(probe.providerSpecificData.validationModelId, "");
  assert.equal(probe.providerSpecificData.customHeader, "keep");
  assert.deepEqual(saved, before);
  assert.equal(applyConnectionTestDraft(saved, { apiKey: "new-key" }).apiKey, "new-key");
});

test("draft input rejects arbitrary connection updates and unsafe URL shapes", () => {
  for (const draft of [
    { isActive: true },
    { baseUrl: "file:///tmp/secret" },
    { baseUrl: "http://user:pass@example.test" },
    { baseUrl: "http://example.test?key=secret" },
  ]) {
    assert.equal(providerConnectionTestBodySchema.safeParse({ draft }).success, false);
  }
});

test("manual failures and successful drafts never mutate routing health", () => {
  assert.equal(isReadOnlyConnectionProbe(true, undefined, false), true);
  assert.equal(isReadOnlyConnectionProbe(true, {}, true), true);
  assert.equal(
    isReadOnlyConnectionProbe(false, undefined, false),
    false,
    "background health checks retain their policy"
  );
  assert.equal(
    isReadOnlyConnectionProbe(true, undefined, true),
    false,
    "saved success can recover"
  );
});

test("saved manual success recovers transient cooldowns while retaining real quota and unknown gates", () => {
  const rateLimitedUntil = new Date(Date.now() + 3600000).toISOString();
  assert.equal(
    canRecoverManualProbe({ rateLimitedUntil, lastErrorType: "network_error" }, true),
    true
  );
  assert.equal(
    canRecoverManualProbe({ rateLimitedUntil, lastErrorType: "upstream_auth_error" }, false),
    false
  );
  assert.equal(
    canRecoverManualProbe(
      { rateLimitedUntil, lastErrorType: "upstream_rate_limited", errorCode: 429 },
      true
    ),
    false
  );
  assert.equal(
    canRecoverManualProbe(
      { rateLimitedUntil, lastErrorType: "network_error", errorCode: 429 },
      true
    ),
    false
  );
  assert.equal(canRecoverManualProbe({ rateLimitedUntil }, true), false);
  assert.equal(canRecoverManualProbe({ rateLimitedUntil: new Date(0).toISOString() }, true), true);
});
