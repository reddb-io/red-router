import assert from "node:assert/strict";
import test from "node:test";
import { registerComboRepositoryConformance } from "../../helpers/persistence/comboRepositoryConformance.ts";
import {
  PgRoutingSnapshotStorage,
  ROUTING_STATE_SCHEMA,
} from "../../../src/lib/db/repositories/pgRoutingSnapshotStorage.ts";
import { sanitizeErrorMessage } from "../../../open-sse/utils/error.ts";
import { createRoutingConfigRepositories } from "../../../src/lib/db/repositories/routingConfigRepositories.ts";
import {
  emptyRoutingSnapshot,
  parseRoutingSnapshot,
  RoutingSnapshotStore,
} from "../../../src/lib/db/repositories/routingSnapshotStore.ts";
import {
  RoutingStorageError,
  type RoutingBackend,
} from "../../../src/lib/db/repositories/routingStorageConfig.ts";

const url = process.env.RED_ROUTER_TEST_DATABASE_URL;
if (!url) {
  test("real online routing conformance (dedicated CI job)", { skip: true }, () => {});
} else {
  const { Pool } = await import("pg");
  const backend = process.env.RED_ROUTER_TEST_BACKEND as RoutingBackend;
  assert.ok(backend === "postgres" || backend === "reddb");
  const storage = new PgRoutingSnapshotStorage({ backend, databaseUrl: url });
  const repos = createRoutingConfigRepositories({ backend }, storage);
  const sql = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  const store = new RoutingSnapshotStore(storage);

  test.before(async () => {
    // CI diagnostics use only the throwaway listener; production errors remain
    // fixed and redacted. Probe each initializer statement to locate pgwire gaps.
    let stage = "connect";
    try {
      await sql.query("SELECT 1");
      stage = "schema";
      await sql.query(ROUTING_STATE_SCHEMA);
      stage = "parameterized read";
      await sql.query("SELECT id FROM redrouter_routing_state WHERE id = $1", ["routing"]);
      stage = "initialize";
      await storage.initialize();
    } catch (error) {
      console.error("Online routing CI probe failed:", stage, sanitizeErrorMessage(error));
      throw new RoutingStorageError("unavailable");
    }
  });
  const reset = async () => {
    await store.mutate((state) => {
      Object.assign(state, emptyRoutingSnapshot());
      return { result: undefined, changed: true };
    });
  };
  registerComboRepositoryConformance(async () => ({
    combos: repos.combos,
    mappings: repos.modelComboMappings,
    reset,
    async corruptComboPayload(id: string) {
      await store.mutate((state) => {
        state.combos.find((row) => row.id === id)!.data = "";
        return { result: undefined, changed: true };
      });
    },
  }));

  test("real backend: initialize preserves data, CAS detects stale writers and deletion is durable", async () => {
    await reset();
    const created = await repos.combos.create({ name: "persisted", models: [] });
    await storage.initialize();
    assert.equal(await repos.combos.count(), 1);
    const before = await storage.load();
    assert.equal(await storage.compareAndSwap(before.revision, before.data), true);
    assert.equal(await storage.compareAndSwap(before.revision, before.data), false);
    await repos.combos.deleteById(String(created.id));
    await storage.close();
    const reopened = new PgRoutingSnapshotStorage({ backend, databaseUrl: url });
    assert.equal(parseRoutingSnapshot((await reopened.load()).data).combos.length, 0);
    await reopened.close();
  });

  test("real backend: competing writers preserve all rows and uniqueness", async () => {
    await reset();
    const peerStorage = new PgRoutingSnapshotStorage({ backend, databaseUrl: url });
    const peer = createRoutingConfigRepositories({ backend }, peerStorage);
    try {
      await Promise.all([
        repos.combos.create({ name: "one", models: [] }),
        peer.combos.create({ name: "two", models: [] }),
        repos.combos.create({ name: "three", models: [] }),
        peer.combos.create({ name: "four", models: [] }),
      ]);
      assert.equal(await repos.combos.count(), 4);
      const results = await Promise.allSettled([
        repos.combos.create({ name: "unique", models: [] }),
        peer.combos.create({ name: "unique", models: [] }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(await repos.combos.count(), 5);
    } finally {
      await peer.close();
    }
  });

  test("real backend: missing state rejects writes without seeding or falling back", async () => {
    await sql.query("DELETE FROM redrouter_routing_state WHERE id = $1", ["routing"]);
    await assert.rejects(
      repos.combos.create({ name: "must-not-exist", models: [] }),
      (error: unknown) => error instanceof RoutingStorageError && error.code === "not_initialized"
    );
    const { rows } = await sql.query("SELECT id FROM redrouter_routing_state");
    assert.equal(rows.length, 0);
    await storage.initialize();
  });

  test("real backend: unavailable transport is bounded, classified and redacted", async () => {
    const unavailable = new PgRoutingSnapshotStorage({
      backend,
      databaseUrl: "postgresql://secret:token@127.0.0.1:1/routing",
    });
    const failing = createRoutingConfigRepositories({ backend }, unavailable);
    const start = Date.now();
    try {
      await assert.rejects(
        failing.combos.create({ name: "offline", models: [] }),
        (error: unknown) =>
          error instanceof RoutingStorageError &&
          error.code === "unavailable" &&
          !error.message.includes("token") &&
          !error.stack?.includes("postgresql://")
      );
      assert.ok(Date.now() - start < 10000);
      assert.equal(failing.backend, backend);
    } finally {
      await failing.close();
    }
  });

  test.after(async () => {
    await storage.close();
    await sql.end();
  });
}
