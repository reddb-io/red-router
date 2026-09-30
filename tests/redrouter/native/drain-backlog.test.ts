import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

// Real database on a scratch install. JWT_SECRET is fixed so a dashboard session can be minted.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-drain-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-drain";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const drainMode = await import("../../../src/lib/system/drainMode.ts");
const { trackRequest, getActiveRequestCount } =
  await import("../../../src/lib/gracefulShutdown.ts");
const { markServerReady, markServerStarting } = await import("../../../src/lib/serverLifecycle.ts");
const drainRoute = await import("../../../src/app/api/system/drain/route.ts");
const backlogRoute = await import("../../../src/app/api/system/backlog/route.ts");
const readyz = await import("../../../src/app/readyz/route.ts");
const healthz = await import("../../../src/app/healthz/route.ts");
const pipeline = await import("../../../src/server/authz/pipeline.ts");
const logExportDb = await import("../../../src/lib/db/logExportDestinations.ts");

const PASSWORD = "correct horse battery staple 42";

after(() => {
  drainMode.stopManualDrain();
  markServerStarting();
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  drainMode.stopManualDrain();
  markServerReady();
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword(PASSWORD),
  });
});

async function cookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

const call = async (
  handler: (request: Request) => Promise<Response>,
  method: string,
  authed: boolean
) =>
  handler(
    new Request("http://localhost/api/system/drain", {
      method,
      headers: authed ? { cookie: await cookie() } : {},
    })
  );

test("drain and backlog need management auth", async () => {
  assert.equal((await call(drainRoute.POST, "POST", false)).status, 401);
  assert.equal((await call(drainRoute.DELETE, "DELETE", false)).status, 401);
  assert.equal((await call(drainRoute.GET, "GET", false)).status, 401);
  assert.equal((await call(backlogRoute.GET, "GET", false)).status, 401);
  assert.equal(drainMode.isManualDrainActive(), false, "an unauthenticated POST changes nothing");
});

test("draining flips readyz and healthz to 503 draining, and DELETE clears it", async () => {
  assert.equal((await readyz.GET()).status, 200);

  const started = await call(drainRoute.POST, "POST", true);
  assert.equal(started.status, 200);
  const state = (await started.json()) as { draining: boolean; since: string; inFlight: number };
  assert.equal(state.draining, true);
  assert.match(state.since, /^\d{4}-\d{2}-\d{2}T/);

  for (const route of [readyz, healthz]) {
    const response = await route.GET();
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "draining\n");
    assert.equal((await route.HEAD()).status, 503);
  }

  // Idempotent: a second POST keeps the original start time.
  const again = (await (await call(drainRoute.POST, "POST", true)).json()) as { since: string };
  assert.equal(again.since, state.since);

  const cleared = (await (await call(drainRoute.DELETE, "DELETE", true)).json()) as {
    draining: boolean;
    since: string | null;
  };
  assert.deepEqual([cleared.draining, cleared.since], [false, null]);
  const ready = await readyz.GET();
  assert.equal(ready.status, 200);
  assert.equal(await ready.text(), "ok\n");
});

test("draining does not mask the other lifecycle phases", async () => {
  drainMode.startManualDrain();
  markServerStarting();
  assert.equal(await (await readyz.GET()).text(), "starting\n");
});

test("new client API requests answer 503 with Retry-After; management and reads stay up", async () => {
  const chat = () =>
    pipeline.runAuthzPipeline(
      new NextRequest("http://localhost/v1/chat/completions", { method: "POST", body: "{}" }),
      { enforce: true }
    );

  const before = await chat();
  assert.notEqual(before.status, 503, "not drained yet");

  drainMode.startManualDrain();
  const rejected = await chat();
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "5");
  assert.equal(rejected.headers.get("x-omniroute-route-class"), "CLIENT_API");
  const body = (await rejected.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
  assert.match(body.error.message, /draining/i);

  const responses = await pipeline.runAuthzPipeline(
    new NextRequest("http://localhost/responses", { method: "POST", body: "{}" }),
    { enforce: true }
  );
  assert.equal(responses.status, 503, "rewritten aliases are drained too");

  const models = await pipeline.runAuthzPipeline(
    new NextRequest("http://localhost/v1/models", { method: "GET" }),
    { enforce: true }
  );
  assert.notEqual(models.status, 503, "read-only listing stays up");

  const lift = await pipeline.runAuthzPipeline(
    new NextRequest("http://localhost/api/system/drain", {
      method: "DELETE",
      headers: { cookie: await cookie() },
    }),
    { enforce: true }
  );
  assert.notEqual(lift.status, 503, "the management route that lifts the drain stays reachable");

  drainMode.stopManualDrain();
  assert.notEqual((await chat()).status, 503, "requests flow again after DELETE");
});

test("in-flight requests are counted and never aborted by a drain", async () => {
  const done = trackRequest();
  const baseline = getActiveRequestCount();
  assert.ok(baseline >= 1);
  const started = (await (await call(drainRoute.POST, "POST", true)).json()) as {
    inFlight: number;
  };
  assert.equal(started.inFlight, baseline, "drain reports the in-flight count and leaves it alone");
  assert.equal(getActiveRequestCount(), baseline);
  done();
  assert.equal(getActiveRequestCount(), baseline - 1);
});

test("backlog reports in-flight, drain state, usage-sink outbox and log-export depth", async () => {
  const destination = logExportDb.createLogExportDestination({
    name: "collector",
    type: "otlp",
    enabled: true,
    config: { endpoint: "https://collector.example.com" },
  });
  assert.ok(destination.id);

  const done = trackRequest();
  drainMode.startManualDrain();
  const response = await call(backlogRoute.GET, "GET", true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as {
    generatedAt: string;
    draining: { draining: boolean; shuttingDown: boolean };
    inFlight: { requests: number };
    chatAdmission: Record<string, number>;
    usageSinks: Record<string, number>;
    logExport: { pending: number; destinations: Array<{ name: string; type: string }> };
  };
  done();

  assert.deepEqual(Object.keys(body).sort(), [
    "chatAdmission",
    "draining",
    "generatedAt",
    "inFlight",
    "logExport",
    "usageSinks",
  ]);
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.draining.draining, true);
  assert.equal(body.draining.shuttingDown, false);
  assert.ok(body.inFlight.requests >= 1);
  assert.deepEqual(Object.keys(body.chatAdmission).sort(), [
    "activeHeavy",
    "queuedBytes",
    "shedTotal",
    "waiting",
  ]);
  assert.deepEqual(body.usageSinks, { pending: 0, dead: 0, sinks: 0 });
  assert.equal(body.logExport.pending, 0);
  assert.deepEqual(
    body.logExport.destinations.map((d) => [d.name, d.type]),
    [["collector", "otlp"]]
  );
  // Nothing sensitive (config, cursor internals) is exposed per destination.
  assert.deepEqual(Object.keys(body.logExport.destinations[0]).sort(), [
    "id",
    "name",
    "pending",
    "type",
  ]);
});
