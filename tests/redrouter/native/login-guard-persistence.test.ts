import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// The sign-in lockout survives a restart and escalates for repeat offenders.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-login-guard-"));
process.env.DATA_DIR = dataDir;

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const guard = await import("../../../src/server/auth/loginGuard.ts");

const ON = { enabled: true };
const { LOCKOUT_STEPS_MS, LEVEL_DECAY_MS, FAILURE_THRESHOLD, WINDOW_MS } =
  guard.LOGIN_GUARD_TUNABLES;
const MIN = 60 * 1000;

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  guard.resetLoginGuardForTests();
});

function failUntilLocked(ip: string) {
  let last = guard.recordLoginFailure(ip, ON);
  for (let i = 1; i < FAILURE_THRESHOLD; i += 1) last = guard.recordLoginFailure(ip, ON);
  return last;
}

test("the first lockout keeps the historic 15 minutes", () => {
  const decision = failUntilLocked("10.0.0.1");
  assert.equal(decision.allowed, false);
  assert.equal(decision.level, 1);
  assert.equal(decision.retryAfterSeconds, (15 * MIN) / 1000);
  assert.equal(guard.checkLoginGuard("10.0.0.1", ON).allowed, false);
  assert.equal(guard.checkLoginGuard("10.0.0.2", ON).allowed, true, "other clients are unaffected");
});

test("a lockout survives a restart", () => {
  failUntilLocked("10.0.0.1");
  guard.simulateRestartForTests();
  const after = guard.checkLoginGuard("10.0.0.1", ON);
  assert.equal(after.allowed, false);
  assert.ok((after.retryAfterSeconds ?? 0) > 14 * 60, "the remaining time is kept, not restarted");
  assert.equal(guard.checkLoginGuard("10.0.0.9", ON).allowed, true);
});

test("failure counters are not persisted: a restart does not carry a half-spent budget", () => {
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) guard.recordLoginFailure("10.0.0.1", ON);
  guard.simulateRestartForTests();
  assert.equal(guard.checkLoginGuard("10.0.0.1", ON).allowed, true);
  const rows = getDbInstance().prepare("SELECT COUNT(*) AS n FROM login_lockouts").get() as {
    n: number;
  };
  assert.equal(rows.n, 0, "only lockout decisions are stored");
});

test("repeat lockouts escalate through the steps and cap at the last one", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const seconds: number[] = [];
  for (let round = 0; round < LOCKOUT_STEPS_MS.length + 2; round += 1) {
    const decision = failUntilLocked("10.0.0.1");
    seconds.push(decision.retryAfterSeconds ?? 0);
    // Wait out the lock (but stay well inside the decay window).
    t.mock.timers.tick((decision.retryAfterSeconds ?? 0) * 1000 + 1000);
  }
  const expected = [...LOCKOUT_STEPS_MS, LOCKOUT_STEPS_MS.at(-1)!, LOCKOUT_STEPS_MS.at(-1)!].map(
    (ms) => ms / 1000
  );
  assert.deepEqual(seconds, expected);
});

test("the escalation level also survives a restart", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const first = failUntilLocked("10.0.0.1");
  t.mock.timers.tick((first.retryAfterSeconds ?? 0) * 1000 + 1000);
  guard.simulateRestartForTests();
  const second = failUntilLocked("10.0.0.1");
  assert.equal(second.level, 2);
  assert.equal(second.retryAfterSeconds, LOCKOUT_STEPS_MS[1] / 1000);
});

test("a client that stays clean for a day starts again at level 1", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const first = failUntilLocked("10.0.0.1");
  t.mock.timers.tick((first.retryAfterSeconds ?? 0) * 1000 + LEVEL_DECAY_MS + 1000);
  guard.simulateRestartForTests();
  assert.equal(guard.checkLoginGuard("10.0.0.1", ON).allowed, true);
  const again = failUntilLocked("10.0.0.1");
  assert.equal(again.level, 1);
  assert.equal(again.retryAfterSeconds, LOCKOUT_STEPS_MS[0] / 1000);
});

test("a successful sign-in clears the counters, the level and the stored decision", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const first = failUntilLocked("10.0.0.1");
  t.mock.timers.tick((first.retryAfterSeconds ?? 0) * 1000 + 1000);
  guard.clearLoginAttempts("10.0.0.1");
  const rows = getDbInstance().prepare("SELECT COUNT(*) AS n FROM login_lockouts").get() as {
    n: number;
  };
  assert.equal(rows.n, 0);
  assert.equal(failUntilLocked("10.0.0.1").level, 1, "back to the first step");
});

test("a lock still running is not lifted by a restart mid-window, and disabled means disabled", () => {
  failUntilLocked("10.0.0.1");
  guard.simulateRestartForTests();
  assert.equal(guard.recordLoginFailure("10.0.0.1", { enabled: false }).allowed, true);
  assert.equal(guard.checkLoginGuard("10.0.0.1", { enabled: false }).allowed, true);
  assert.equal(guard.checkLoginGuard("10.0.0.1", ON).allowed, false);
});

test("the sliding window still forgives failures spread over time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) guard.recordLoginFailure("10.0.0.1", ON);
  t.mock.timers.tick(WINDOW_MS + 1000);
  assert.equal(guard.recordLoginFailure("10.0.0.1", ON).allowed, true);
  assert.equal(guard.checkLoginGuard("10.0.0.1", ON).allowed, true);
});
