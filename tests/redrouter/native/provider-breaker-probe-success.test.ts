import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-provider-probe-"));
process.env.DATA_DIR = directory;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { CircuitBreaker, getCircuitBreaker, resetAllCircuitBreakers } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { recordProviderSuccess } = await import("../../../open-sse/services/accountFallback.ts");
const { connectionCircuitBreakerName } =
  await import("../../../open-sse/services/connectionCircuitBreaker.ts");

const now = 1_700_000_000_000;
const resetTimeout = 30_000;
afterEach(() => resetAllCircuitBreakers());
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("a successful consumed HALF_OPEN probe closes the provider parent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const provider = "probe-parent-recovery";
  const connection = "connection-1";
  const parent = getCircuitBreaker(provider, {
    failureThreshold: 1,
    halfOpenRequests: 1,
    resetTimeout,
  });
  const child = getCircuitBreaker(connectionCircuitBreakerName(provider, connection));
  parent._onFailure();
  t.mock.timers.tick(resetTimeout);
  await parent.execute(
    async () => {
      assert.equal(parent.getStatus().state, "HALF_OPEN");
      assert.equal(parent.canExecute(), false, "the in-flight probe consumed the only slot");
      recordProviderSuccess(provider, connection);
      assert.equal(parent.getStatus().state, "CLOSED");
      assert.equal(child.getStatus().state, "CLOSED");
    },
    { classifyResult: () => "ignore" }
  );
  assert.equal(parent.failureCount, 0);
});

test("a connection success cannot prematurely close an OPEN parent", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const provider = "stale-success-parent";
  const parent = getCircuitBreaker(provider, { failureThreshold: 1, resetTimeout });
  getCircuitBreaker(connectionCircuitBreakerName(provider, "old-request"));
  parent._onFailure();
  recordProviderSuccess(provider, "old-request");
  assert.equal(parent.getStatus().state, "OPEN");
  assert.equal(parent.failureCount, 1);
});

test("an expired probe cannot settle the current generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const breaker = new CircuitBreaker("expired-generation-success", {
    failureThreshold: 1,
    halfOpenRequests: 1,
    resetTimeout,
  });
  breaker._onFailure();
  t.mock.timers.tick(resetTimeout);
  let settleOld!: () => void;
  const old = breaker.execute(
    () =>
      new Promise<void>((resolve) => {
        settleOld = resolve;
      })
  );
  t.mock.timers.tick(resetTimeout);
  assert.equal(breaker.canExecute(), true);
  let settleCurrent!: () => void;
  const current = breaker.execute(
    () =>
      new Promise<void>((resolve) => {
        settleCurrent = resolve;
      })
  );
  settleOld();
  await old;
  assert.equal(breaker.state, "HALF_OPEN");
  assert.equal(breaker.canExecute(), false);
  settleCurrent();
  await current;
  assert.equal(breaker.state, "CLOSED");
});

test("an expired probe failure cannot reopen the current generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const breaker = new CircuitBreaker("expired-generation-failure", {
    failureThreshold: 1,
    halfOpenRequests: 1,
    resetTimeout,
  });
  breaker._onFailure();
  t.mock.timers.tick(resetTimeout);
  let failOld!: (error: Error) => void;
  const old = breaker.execute(
    () =>
      new Promise<void>((_resolve, reject) => {
        failOld = reject;
      })
  );
  t.mock.timers.tick(resetTimeout);
  assert.equal(breaker.canExecute(), true);
  let settleCurrent!: () => void;
  const current = breaker.execute(
    () =>
      new Promise<void>((resolve) => {
        settleCurrent = resolve;
      })
  );
  failOld(new Error("expired attempt"));
  await assert.rejects(old, /expired attempt/);
  assert.equal(breaker.state, "HALF_OPEN");
  assert.equal(breaker.canExecute(), false);
  settleCurrent();
  await current;
  assert.equal(breaker.state, "CLOSED");
});
