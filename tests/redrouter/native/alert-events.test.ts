import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install; the webhook dispatcher is replaced by a capture seam.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-alert-events-"));
process.env.DATA_DIR = dataDir;

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const alerts = await import("../../../src/lib/alerts/alertEvents.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { saveQuotaSnapshot } = await import("../../../src/lib/db/quotaSnapshots.ts");
const { getCircuitBreaker, resetAllCircuitBreakers } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { EVENT_DESCRIPTIONS, WEBHOOK_EVENT_VALUES } =
  await import("../../../src/lib/webhooks/eventDescriptions.ts");
const { buildDiscordPayload } = await import("../../../src/lib/webhooks/integrations/discord.ts");

type Captured = { event: string; data: Record<string, unknown> };
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  alerts.__resetAlertStateForTest();
  alerts.__setAlertEmitterForTest((event, data) => captured.push({ event, data }));
});

after(() => {
  alerts.__setAlertEmitterForTest(null);
  resetAllCircuitBreakers();
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const T0 = 1_800_000_000_000;

test("the four alert events are registered with descriptions and a Discord colour", () => {
  for (const event of [
    "provider.circuit_open",
    "provider.circuit_closed",
    "connection.unavailable",
    "quota.low",
  ] as const) {
    assert.ok(WEBHOOK_EVENT_VALUES.includes(event), event);
    assert.ok(EVENT_DESCRIPTIONS[event].label.length > 0);
    const embed = buildDiscordPayload(event, EVENT_DESCRIPTIONS[event].exampleData).embeds?.[0];
    assert.notEqual(embed?.color, 0x6366f1, `${event} has its own colour`);
  }
});

test("a breaker flapping ten times emits one event per state per five minutes", () => {
  for (let i = 0; i < 10; i++) {
    alerts.notifyCircuitTransition("claude", "CLOSED", "OPEN", "kind:transient", T0 + i * 1000);
    alerts.notifyCircuitTransition("claude", "OPEN", "HALF_OPEN", "timeout-elapsed", T0 + i * 1000);
    alerts.notifyCircuitTransition("claude", "HALF_OPEN", "CLOSED", "probe-success", T0 + i * 1000);
  }
  const events = captured.map((entry) => entry.event);
  assert.deepEqual(events, ["provider.circuit_open", "provider.circuit_closed"]);

  // Another provider is independent, and the window reopens after five minutes.
  alerts.notifyCircuitTransition("openai", "CLOSED", "OPEN", null, T0 + 20_000);
  alerts.notifyCircuitTransition("claude", "CLOSED", "OPEN", null, T0 + 5 * 60_000 + 1);
  assert.equal(captured.filter((entry) => entry.event === "provider.circuit_open").length, 3);
});

test("only recoveries from an open breaker are reported, and connection-scoped breakers are ignored", () => {
  alerts.notifyCircuitTransition("claude", "CLOSED", "DEGRADED", null, T0);
  alerts.notifyCircuitTransition("claude", "DEGRADED", "CLOSED", "recovery", T0 + 1);
  alerts.notifyCircuitTransition("claude::conn::abc", "CLOSED", "OPEN", null, T0 + 2);
  assert.deepEqual(captured, []);
});

test("the real breaker fires the hook on its state transitions", async () => {
  const breaker = getCircuitBreaker("alert-test-provider", {
    failureThreshold: 2,
    resetTimeout: 50,
  });
  const failing = () => Promise.reject(new Error("upstream said sk-live-SECRET-KEY-123"));
  for (let i = 0; i < 6; i++) await breaker.execute(failing).catch(() => {});
  const opens = captured.filter((entry) => entry.event === "provider.circuit_open");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].data.provider, "alert-test-provider");
  assert.equal(opens[0].data.state, "OPEN");
  assert.doesNotMatch(JSON.stringify(captured), /sk-live|upstream said/);
});

test("a throwing emitter can never break the breaker or the caller", () => {
  alerts.__setAlertEmitterForTest(() => {
    throw new Error("dispatcher exploded");
  });
  assert.doesNotThrow(() => alerts.notifyCircuitTransition("claude", "CLOSED", "OPEN", "x", T0));
  assert.doesNotThrow(() => alerts.notifyConnectionStatusChange(null, undefined));
  assert.doesNotThrow(() => alerts.notifyQuotaSnapshot({ remaining_percentage: "nope" }));
});

test("reason codes are short machine codes, never sentences", () => {
  assert.equal(alerts.toReasonCode("probe-failed (cycle 3)"), "probe-failed");
  assert.equal(alerts.toReasonCode("kind:rate_limit"), "kind:rate_limit");
  assert.equal(alerts.toReasonCode(undefined), null);
  assert.equal(alerts.toReasonCode("   "), null);
});

test("connection.unavailable fires once, only when entering a terminal state", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "victim@example.com",
    email: "victim@example.com",
    apiKey: "sk-fake-secret-key-0123456789",
  });
  const id = connection.id as string;

  await providersDb.updateProviderConnection(id, { testStatus: "active" });
  await providersDb.updateProviderConnection(id, {
    testStatus: "unavailable",
    lastErrorType: "rate_limited",
  });
  assert.deepEqual(captured, [], "cooldown states are not terminal");

  await providersDb.updateProviderConnection(id, {
    testStatus: "banned",
    lastErrorType: "account_deactivated",
    errorCode: 403,
    lastError: "Your key sk-fake-secret-key-0123456789 was banned for victim@example.com",
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, "connection.unavailable");
  assert.equal(captured[0].data.provider, "openai");
  assert.equal(captured[0].data.connectionId, id);
  assert.equal(captured[0].data.state, "banned");
  assert.equal(captured[0].data.reason, "account_deactivated");
  assert.equal(captured[0].data.errorCode, 403);

  // Rewriting the same terminal state (a retry loop) does not emit again.
  await providersDb.updateProviderConnection(id, { testStatus: "banned", errorCode: 403 });
  assert.equal(captured.length, 1);

  // A different terminal state is a state change.
  await providersDb.updateProviderConnection(id, { testStatus: "credits_exhausted" });
  assert.equal(captured.length, 2);
  assert.equal(captured[1].data.state, "credits_exhausted");
  assert.equal(captured[1].data.previousState, "banned");
});

test("no alert payload carries keys, tokens, e-mails or free-text errors", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "anthropic",
    authType: "oauth",
    name: "Personal account",
    email: "owner@example.org",
    accessToken: "at-fake-access-token-9999",
    refreshToken: "rt-fake-refresh-token-9999",
    apiKey: "sk-ant-fake-key-9999",
  });
  await providersDb.updateProviderConnection(connection.id as string, {
    testStatus: "expired",
    lastErrorType: "token_expired",
    lastError: "401 for owner@example.org with token at-fake-access-token-9999",
  });
  saveQuotaSnapshot({
    provider: "anthropic",
    connection_id: connection.id as string,
    window_key: "weekly",
    remaining_percentage: 4,
    is_exhausted: 0,
    next_reset_at: "2026-10-01T00:00:00.000Z",
    window_duration_ms: 604_800_000,
    raw_data: JSON.stringify({ token: "at-fake-access-token-9999", email: "owner@example.org" }),
  });
  alerts.notifyCircuitTransition("anthropic", "CLOSED", "OPEN", "kind:transient", T0);

  const events = captured.map((entry) => entry.event).sort();
  assert.deepEqual(events, ["connection.unavailable", "provider.circuit_open", "quota.low"]);
  const wire = JSON.stringify(captured);
  for (const secret of [
    "owner@example.org",
    "fake-access-token",
    "fake-refresh-token",
    "sk-ant-fake",
    "Personal account",
    "401 for",
  ]) {
    assert.equal(wire.includes(secret), false, `payload leaked ${secret}`);
  }
  for (const entry of captured) {
    assert.match(String(entry.data.at), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(typeof entry.data.provider === "string");
  }
});

test("quota.low alerts once per window, re-arms after recovery, and ignores healthy readings", () => {
  const snap = (remaining: number, exhausted = 0) => ({
    provider: "codex",
    connection_id: "c1",
    window_key: "weekly",
    remaining_percentage: remaining,
    is_exhausted: exhausted,
    next_reset_at: null,
  });
  alerts.notifyQuotaSnapshot(snap(60));
  alerts.notifyQuotaSnapshot(snap(12));
  assert.equal(captured.length, 0, "12% is above the 10% line");

  alerts.notifyQuotaSnapshot(snap(9));
  alerts.notifyQuotaSnapshot(snap(7));
  alerts.notifyQuotaSnapshot(snap(0, 1));
  assert.equal(captured.length, 1, "a steady low reading alerts once");
  assert.equal(captured[0].data.remainingPercentage, 9);

  alerts.notifyQuotaSnapshot(snap(12));
  alerts.notifyQuotaSnapshot(snap(8));
  assert.equal(captured.length, 1, "12% is inside the hysteresis band, still armed off");

  alerts.notifyQuotaSnapshot(snap(80));
  alerts.notifyQuotaSnapshot(snap(5));
  assert.equal(captured.length, 2, "re-armed after recovering above 15%");

  alerts.notifyQuotaSnapshot({ ...snap(5), window_key: "session" });
  assert.equal(captured.length, 3, "windows are tracked independently");
});
