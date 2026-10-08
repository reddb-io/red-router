import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRoutingStorage } from "../../helpers/persistence/memoryRoutingStorage.ts";
import { emptyRoutingSnapshot } from "../../../src/lib/db/repositories/routingSnapshotStore.ts";
import { importEmptyRoutingSnapshot } from "../../../src/lib/db/repositories/routingStorageMaintenance.ts";
import { RoutingStorageError } from "../../../src/lib/db/repositories/routingStorageConfig.ts";

test("maintenance import is atomic, accepts only an empty destination, and never overwrites a racing writer", async () => {
  const storage = new MemoryRoutingStorage();
  const state = emptyRoutingSnapshot();
  state.combos.push({
    id: "restored",
    name: "restored",
    data: "{}",
    sortOrder: 1,
    contextCacheProtection: 0,
  });
  const data = JSON.stringify(state);
  await importEmptyRoutingSnapshot(storage, data);
  const saved = storage.data;
  await assert.rejects(importEmptyRoutingSnapshot(storage, data), RoutingStorageError);
  assert.equal(storage.data, saved);
  storage.data = JSON.stringify(emptyRoutingSnapshot());
  storage.compareAndSwap = async () => {
    throw new RoutingStorageError("unavailable");
  };
  await assert.rejects(importEmptyRoutingSnapshot(storage, data), RoutingStorageError);
  assert.equal(storage.data, JSON.stringify(emptyRoutingSnapshot()));
  storage.compareAndSwap = async () => false;
  await assert.rejects(
    importEmptyRoutingSnapshot(storage, data),
    (error: unknown) => error instanceof RoutingStorageError && error.code === "conflict"
  );
});
