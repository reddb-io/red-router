import assert from "node:assert/strict";
import test from "node:test";
process.env.RED_ROUTER_ROUTING_BACKEND = "postgres";
process.env.RED_ROUTER_ROUTING_DATABASE_URL = "postgresql://secret:token@127.0.0.1:1/routing";
const { GET } = await import("../../../src/app/api/health/ping/route.ts");
const core = await import("../../../src/lib/db/core.ts");
const facade = await import("../../../src/lib/db/combos.ts");
const { RoutingStorageError, requireCompleteSqlitePersistence } =
  await import("../../../src/lib/db/repositories/routingStorageConfig.ts");
const { routingConfigRepositories } =
  await import("../../../src/lib/db/repositories/routingConfigRepositories.ts");

test("readiness fails on external outage while SQLite remains healthy; writes never fall back", async () => {
  assert.ok(core.pingDb());
  const response = await GET();
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(!body.includes("token") && !body.includes("secret") && !body.includes("at /"));
  await assert.rejects(
    facade.createCombo({ name: "never-local", models: [] }),
    RoutingStorageError
  );
  assert.equal(
    (core.getDbInstance().prepare("SELECT count(*) AS n FROM combos").get() as { n: number }).n,
    0
  );
  assert.equal(routingConfigRepositories.backend, "postgres");
  assert.throws(
    requireCompleteSqlitePersistence,
    (error: unknown) =>
      error instanceof RoutingStorageError && error.code === "unsupported_operation"
  );
  // Selection is frozen; environment mutation cannot turn an outage into SQLite writes.
  process.env.RED_ROUTER_ROUTING_BACKEND = "sqlite";
  assert.equal(routingConfigRepositories.backend, "postgres");
  await assert.rejects(
    facade.createCombo({ name: "still-never-local", models: [] }),
    RoutingStorageError
  );
});

test("external routing refuses tenant ownership that has not crossed the repository boundary", async () => {
  const { createTenant } = await import("../../../src/lib/db/tenants.ts");
  createTenant({ slug: "another", name: "Another tenant" });
  await assert.rejects(
    facade.createCombo({ name: "tenant-rejected", models: [] }),
    (error: unknown) =>
      error instanceof RoutingStorageError && error.code === "unsupported_operation"
  );
  assert.equal((await GET()).status, 503);
});
test.after(async () => {
  await routingConfigRepositories.close();
  core.resetDbInstance();
});
