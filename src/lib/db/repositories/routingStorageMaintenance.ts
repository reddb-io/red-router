import { RoutingStorageError } from "./routingStorageConfig";
import {
  RoutingSnapshotStore,
  emptyRoutingSnapshot,
  parseRoutingSnapshot,
  type RoutingSnapshotStorage,
} from "./routingSnapshotStore";
import { sqliteComboRepository } from "./sqliteComboRepository";
import { sqliteModelComboMappingRepository } from "./sqliteModelComboMappingRepository";

/** Run only with every writer stopped. This is a bounded routing export, not a whole-DB migration. */
export async function exportSqliteRoutingSnapshot(): Promise<string> {
  const combos = await sqliteComboRepository.list();
  if (combos.length !== (await sqliteComboRepository.count()))
    throw new RoutingStorageError("invalid_snapshot");
  const mappings = await sqliteModelComboMappingRepository.list();
  const state = emptyRoutingSnapshot();
  state.combos = combos.map((combo) => {
    if (
      typeof combo.id !== "string" ||
      typeof combo.name !== "string" ||
      typeof combo.sortOrder !== "number"
    )
      throw new RoutingStorageError("invalid_snapshot");
    return {
      id: combo.id,
      name: combo.name,
      sortOrder: combo.sortOrder,
      contextCacheProtection: combo.context_cache_protection ? 1 : 0,
      data: JSON.stringify(combo),
    };
  });
  state.mappings = mappings.items.map(({ comboName: _name, ...mapping }) => mapping);
  const data = JSON.stringify(state);
  parseRoutingSnapshot(data);
  return data;
}

/** Refuse nonempty destinations; a CAS conflict never becomes an automatic retry/overwrite. */
export async function importEmptyRoutingSnapshot(
  storage: RoutingSnapshotStorage,
  data: string
): Promise<void> {
  const restored = parseRoutingSnapshot(data);
  const current = await storage.load();
  const state = parseRoutingSnapshot(current.data);
  if (state.combos.length || state.mappings.length || state.pendingCleanup.length) {
    throw new RoutingStorageError("conflict");
  }
  // Validate the revision through the same store contract, without a write.
  await new RoutingSnapshotStore(storage).mutate(() => ({ result: undefined, changed: false }));
  if (!(await storage.compareAndSwap(current.revision, JSON.stringify(restored)))) {
    throw new RoutingStorageError("conflict");
  }
}
