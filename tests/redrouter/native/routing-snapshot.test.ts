import assert from "node:assert/strict";
import test from "node:test";
import { registerComboRepositoryConformance } from "../../helpers/persistence/comboRepositoryConformance.ts";
import { MemoryRoutingStorage } from "../../helpers/persistence/memoryRoutingStorage.ts";
import {
  readRoutingStorageConfig,
  RoutingStorageError,
} from "../../../src/lib/db/repositories/routingStorageConfig.ts";
import { createRoutingConfigRepositories } from "../../../src/lib/db/repositories/routingConfigRepositories.ts";
import {
  RoutingSnapshotStore,
  parseRoutingSnapshot,
  MAX_ROUTING_SNAPSHOT_BYTES,
} from "../../../src/lib/db/repositories/routingSnapshotStore.ts";
import { routingStorageErrorResponse } from "../../../src/lib/api/routingStorageErrorResponse.ts";

registerComboRepositoryConformance(async () => {
  const storage = new MemoryRoutingStorage();
  const repos = createRoutingConfigRepositories({ backend: "postgres" }, storage);
  return {
    combos: repos.combos,
    mappings: repos.modelComboMappings,
    async reset() {},
    async corruptComboPayload(id: string) {
      const state = parseRoutingSnapshot(storage.data);
      state.combos.find((row) => row.id === id)!.data = "";
      storage.data = JSON.stringify(state);
    },
  };
});

test("SQLite is the default; invalid external configuration fails closed and is redacted", async () => {
  assert.equal(readRoutingStorageConfig({}).backend, "sqlite");
  for (const env of [
    { RED_ROUTER_ROUTING_BACKEND: "unknown" },
    { RED_ROUTER_ROUTING_BACKEND: "reddb" },
    {
      RED_ROUTER_ROUTING_BACKEND: "postgres",
      RED_ROUTER_ROUTING_DATABASE_URL: "https://secret:token@private.example",
    },
  ]) {
    assert.throws(
      () => readRoutingStorageConfig(env),
      (error: unknown) =>
        error instanceof RoutingStorageError &&
        error.code === "configuration" &&
        !error.message.includes("secret")
    );
  }
  const sentinel = new MemoryRoutingStorage();
  sentinel.load = async () => {
    throw new Error("External storage loaded by default");
  };
  assert.equal(
    createRoutingConfigRepositories(readRoutingStorageConfig({}), sentinel).backend,
    "sqlite"
  );
  assert.equal(
    readRoutingStorageConfig({
      RED_ROUTER_ROUTING_BACKEND: "reddb",
      RED_ROUTER_ROUTING_DATABASE_URL: "postgresql://localhost/routing",
    }).backend,
    "reddb"
  );
});

test("concurrent CAS writers preserve uniqueness and no updates are lost", async () => {
  const storage = new MemoryRoutingStorage();
  const a = createRoutingConfigRepositories({ backend: "postgres" }, storage);
  const b = createRoutingConfigRepositories({ backend: "reddb" }, storage);
  await Promise.all([
    a.combos.create({ name: "A", models: [] }),
    b.combos.create({ name: "B", models: [] }),
    a.combos.create({ name: "C", models: [] }),
    b.combos.create({ name: "D", models: [] }),
  ]);
  assert.equal(await a.combos.count(), 4);
  assert.deepEqual(
    (await a.combos.list()).map((row) => row.sortOrder),
    [1, 2, 3, 4]
  );
  const duplicates = await Promise.allSettled([
    a.combos.create({ name: "same", models: [] }),
    b.combos.create({ name: "same", models: [] }),
  ]);
  assert.equal(duplicates.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await a.combos.count(), 5);
});

test("transport failure after a possibly committed write is never retried or sent to SQLite", async () => {
  const storage = new MemoryRoutingStorage();
  const cas = storage.compareAndSwap.bind(storage);
  storage.compareAndSwap = async (revision, data) => {
    await cas(revision, data);
    throw new RoutingStorageError("unavailable");
  };
  const repos = createRoutingConfigRepositories({ backend: "postgres" }, storage);
  await assert.rejects(repos.combos.create({ name: "ambiguous", models: [] }), RoutingStorageError);
  assert.equal(storage.writes, 1);
  assert.equal(await repos.combos.count(), 1);
  assert.equal(repos.backend, "postgres");
});

test("confirmed conflicts have a bounded retry budget", async () => {
  const storage = new MemoryRoutingStorage();
  storage.compareAndSwap = async () => {
    storage.writes++;
    return false;
  };
  const repos = createRoutingConfigRepositories({ backend: "reddb" }, storage);
  await assert.rejects(
    repos.combos.create({ name: "contended", models: [] }),
    (error: unknown) => error instanceof RoutingStorageError && error.code === "conflict"
  );
  assert.equal(storage.writes, 8);
  assert.equal(await repos.combos.count(), 0);
});

test("snapshot validation rejects corrupt references, unknown versions, duplicate names and oversized input", () => {
  for (const data of [
    JSON.stringify({
      schemaVersion: 1,
      mappings: [],
      combos: [
        { id: "one", name: "duplicate", data: "{}", sortOrder: 0, contextCacheProtection: 0 },
        { id: "two", name: "duplicate", data: "{}", sortOrder: 0, contextCacheProtection: 0 },
      ],
    }),
    "not JSON",
    JSON.stringify({ schemaVersion: 2, combos: [], mappings: [] }),
    JSON.stringify({
      schemaVersion: 1,
      combos: [],
      mappings: [
        {
          id: "m",
          comboId: "missing",
          pattern: "*",
          priority: 0,
          enabled: true,
          description: "",
          createdAt: "",
          updatedAt: "",
        },
      ],
    }),
    " ".repeat(MAX_ROUTING_SNAPSHOT_BYTES + 1),
  ])
    assert.throws(() => parseRoutingSnapshot(data), RoutingStorageError);
});

test("delete commits cascade and recovery metadata atomically; failed cleanup can be resumed", async () => {
  const storage = new MemoryRoutingStorage();
  const store = new RoutingSnapshotStore(storage);
  const repos = createRoutingConfigRepositories({ backend: "postgres" }, storage);
  const combo = await repos.combos.create({ name: "recover", models: [] });
  await repos.modelComboMappings.create({ pattern: "*", comboId: String(combo.id) });
  await repos.combos.deleteById(String(combo.id));
  assert.equal((await store.read()).mappings.length, 0);
  await assert.rejects(
    store.drainCleanup(async () => {
      throw new Error("local failure");
    })
  );
  assert.equal((await store.read()).pendingCleanup.length, 1);
  await assert.rejects(repos.combos.create({ name: "recover", models: [] }), RoutingStorageError);
  let effects = 0;
  await store.drainCleanup(async (id, name) => {
    assert.equal(id, combo.id);
    assert.equal(name, "recover");
    effects++;
  });
  await store.drainCleanup(async () => {
    effects++;
  });
  assert.equal(effects, 1);
  assert.equal((await store.read()).pendingCleanup.length, 0);
  await repos.combos.create({ name: "recover", models: [] });
});

test("public storage responses carry stable status and no credentials or stack", async () => {
  for (const code of ["configuration", "unavailable", "not_initialized", "conflict"] as const) {
    const error = new RoutingStorageError(code);
    const response = routingStorageErrorResponse(error)!;
    assert.equal(response.status, error.status);
    const text = await response.text();
    assert.ok(text.includes("routing_storage_" + code));
    assert.ok(!text.includes("at /"));
    assert.ok(!text.includes("postgresql://"));
  }
  assert.equal(routingStorageErrorResponse(new Error("secret")), null);
});
