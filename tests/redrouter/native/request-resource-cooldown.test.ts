import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-resource-cooldown-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "resource-cooldown-regression-secret";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { markAccountUnavailable } = await import("../../../src/sse/services/auth.ts");
const { checkFallbackError } = await import("../../../open-sse/services/accountFallback.ts");
const { classifyProviderError, PROVIDER_ERROR_TYPES } =
  await import("../../../open-sse/services/errorClassifier.ts");

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

const resourceErrors = [
  { code: "thread_not_found", message: "Unknown thread reference" },
  { code: "previous_message_id_not_found", message: "Continuation reference expired" },
  { code: "model_not_found", message: "Thread thread_123 does not exist" },
  { code: "model_not_found", message: "previous_message_id msg_123 not found" },
  { code: "model_not_found", message: "Unknown previous_message_id: msg_123" },
  { code: "model_not_found", message: "Files [file-123] were not found" },
];

test("missing request references bypass generic 404 fallback and provider health classification", () => {
  for (const error of resourceErrors) {
    const body = { error };
    assert.equal(classifyProviderError(404, body, "codex"), null, error.message);
    const result = checkFallbackError(404, JSON.stringify(body), 0, "gpt-test", "codex");
    assert.equal(result.shouldFallback, false, error.message);
    assert.equal(result.cooldownMs, 0);
    assert.equal(result.skipProviderBreaker, true);
    assert.equal(result.reason, "request_resource_not_found");
  }
});

test("structured thread codes are request-scoped even when the message is generic", () => {
  const result = checkFallbackError(404, "Not Found", 0, "gpt-test", "codex", null, null, {
    code: "thread_not_found",
  });
  assert.equal(result.shouldFallback, false);
  assert.equal(result.cooldownMs, 0);
});

test("resource 404s leave existing connection health and backoff state untouched", async () => {
  const connection = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Healthy continuation account",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    isActive: true,
    testStatus: "active",
    backoffLevel: 2,
  });
  const connectionId = String(connection.id);
  const original = await providers.getProviderConnectionById(connectionId);
  for (const error of resourceErrors) {
    const result = await markAccountUnavailable(
      connectionId,
      404,
      JSON.stringify({ error }),
      "codex",
      "gpt-test"
    );
    assert.deepEqual(result, { shouldFallback: false, cooldownMs: 0 });
    assert.deepEqual(await providers.getProviderConnectionById(connectionId), original);
  }
});

test("genuine model and endpoint 404s retain their fallback classification", () => {
  for (const message of ["Model gpt-missing not found", "Not Found", "Endpoint does not exist"]) {
    const body = { error: { code: "model_not_found", message } };
    assert.equal(classifyProviderError(404, body, "codex"), PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND);
    const result = checkFallbackError(404, JSON.stringify(body), 0, "gpt-missing", "codex");
    assert.equal(result.shouldFallback, true, message);
    assert.ok(result.cooldownMs > 0);
  }
});

test("a 503 mentioning a thread still uses the transient upstream failure policy", () => {
  const result = checkFallbackError(503, "Thread service unavailable", 0, "gpt-test", "codex");
  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.notEqual(result.reason, "request_resource_not_found");
});
