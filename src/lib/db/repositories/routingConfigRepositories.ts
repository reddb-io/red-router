import type {
  ComboRepository,
  ModelComboMappingRepository,
} from "@/domain/persistence/comboRepositories";
import { sqliteComboRepository } from "./sqliteComboRepository";
import { sqliteModelComboMappingRepository } from "./sqliteModelComboMappingRepository";
import { PgRoutingSnapshotStorage } from "./pgRoutingSnapshotStorage";
import {
  RoutingStorageError,
  readRoutingStorageConfig,
  type RoutingBackend,
  type RoutingStorageConfig,
} from "./routingStorageConfig";
import { RoutingSnapshotStore, type RoutingSnapshotStorage } from "./routingSnapshotStore";
import { createSnapshotRoutingRepositories } from "./snapshotRoutingRepositories";
import { assertExternalRoutingLocalScope } from "./localComboState";

export interface RoutingConfigRepositories {
  backend: RoutingBackend;
  combos: ComboRepository;
  modelComboMappings: ModelComboMappingRepository;
  close(): Promise<void>;
  reconcileLocalCleanup(): Promise<void>;
}

/** Explicit selection for the experimental routing slice, never an outage fallback. */
export function createRoutingConfigRepositories(
  config: RoutingStorageConfig,
  storage?: RoutingSnapshotStorage
): RoutingConfigRepositories {
  if (config.backend === "sqlite") {
    return {
      backend: "sqlite",
      combos: sqliteComboRepository,
      modelComboMappings: sqliteModelComboMappingRepository,
      close: async () => {},
      reconcileLocalCleanup: async () => {},
    };
  }
  const external = storage ?? new PgRoutingSnapshotStorage(config);
  const store = new RoutingSnapshotStore(external);
  let cleanupPromise: Promise<void> | undefined;
  return {
    backend: config.backend,
    ...createSnapshotRoutingRepositories(store),
    close: () => external.close(),
    reconcileLocalCleanup() {
      // Share one cleanup run among concurrent requests on this node.
      return (cleanupPromise ??= (async () => {
        const { purgeLocalComboState } = await import("./localComboState");
        try {
          await store.drainCleanup(purgeLocalComboState);
        } catch (error) {
          if (error instanceof RoutingStorageError) throw error;
          throw new RoutingStorageError("unavailable");
        }
      })().finally(() => {
        cleanupPromise = undefined;
      }));
    },
  };
}

let selected: RoutingConfigRepositories | undefined;
function configured(): RoutingConfigRepositories {
  selected ??= createRoutingConfigRepositories(readRoutingStorageConfig());
  if (selected.backend !== "sqlite") assertExternalRoutingLocalScope();
  return selected;
}

/** Backend choice is frozen for the process lifetime; changing it requires restart. */
export const routingConfigRepositories: RoutingConfigRepositories = {
  get backend() {
    return configured().backend;
  },
  get combos() {
    return configured().combos;
  },
  get modelComboMappings() {
    return configured().modelComboMappings;
  },
  close: async () => {
    if (selected) await selected.close();
  },
  reconcileLocalCleanup: async () => configured().reconcileLocalCleanup(),
};

export async function verifyRoutingStorage(): Promise<void> {
  if (routingConfigRepositories.backend !== "sqlite") {
    await routingConfigRepositories.combos.count();
    await routingConfigRepositories.reconcileLocalCleanup();
  }
}
