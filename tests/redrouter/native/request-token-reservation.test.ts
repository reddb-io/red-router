import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { isRequestTokenReservationFailure } from "../../../open-sse/services/requestTokenReservation.ts";

const directory = mkdtempSync(join(tmpdir(), "redrouter-token-reservation-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "token-reservation-regression-secret";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const { markAccountUnavailable } = await import("../../../src/sse/services/auth.ts");
const { checkFallbackError, getModelLockoutInfo } =
  await import("../../../open-sse/services/accountFallback.ts");

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

const message =
  "This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 42396.";

test("a request-specific reservation refusal is surfaced without retry or health lockout", async () => {
  for (const provider of ["openrouter", "red-router"]) {
    const model =
      provider === "openrouter" ? "xiaomi/mimo-v2.6-pro" : "openrouter/xiaomi/mimo-v2.6-pro";
    const connection = await providers.createProviderConnection({
      provider,
      authType: "apikey",
      name: "Partially funded wallet",
      apiKey: "test-key",
      isActive: true,
      testStatus: "active",
      backoffLevel: 2,
    });
    const id = String(connection.id);
    const original = await providers.getProviderConnectionById(id);
    for (const errorText of [message, JSON.stringify({ error: { message, code: 402 } })]) {
      const decision = checkFallbackError(402, errorText, 2, model, provider);
      assert.equal(decision.shouldFallback, false);
      assert.equal(decision.cooldownMs, 0);
      assert.equal(decision.skipProviderBreaker, true);
      assert.equal(decision.reason, "request_token_reservation");
      assert.deepEqual(await markAccountUnavailable(id, 402, errorText, provider, model), {
        shouldFallback: false,
        cooldownMs: 0,
      });
      assert.deepEqual(await providers.getProviderConnectionById(id), original);
      assert.equal(getModelLockoutInfo(provider, id, model)?.remainingMs ?? 0, 0);
    }
  }
});

test("empty wallets and unverified errors retain their existing billing policy", () => {
  for (const errorText of [
    message.replace("42396", "0"),
    message.replace("42396", "131072"),
    "Insufficient credits. Add credits to your account.",
    "This request requires more credits, or fewer max_tokens.",
    message.replace("42396", "unknown"),
  ]) {
    assert.equal(isRequestTokenReservationFailure("openrouter", 402, errorText), false);
    assert.notEqual(
      checkFallbackError(402, errorText, 0, "xiaomi/mimo-v2.6-pro", "openrouter").reason,
      "request_token_reservation"
    );
  }
  assert.equal(isRequestTokenReservationFailure("claude", 402, message), false);
  assert.equal(isRequestTokenReservationFailure("red-router", 502, message), false);
});
