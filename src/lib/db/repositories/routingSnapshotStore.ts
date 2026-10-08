import { z } from "zod";
import { RoutingStorageError } from "./routingStorageConfig";

const comboRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  data: z.string(),
  sortOrder: z.number().finite(),
  contextCacheProtection: z.number().int().min(0).max(1),
});
const mappingRowSchema = z.object({
  id: z.string().min(1),
  pattern: z.string(),
  comboId: z.string().min(1),
  priority: z.number().finite(),
  enabled: z.boolean(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    combos: z.array(comboRowSchema),
    mappings: z.array(mappingRowSchema),
    pendingCleanup: z
      .array(
        z
          .object({
            token: z.string().min(1),
            id: z.string().min(1),
            name: z.string(),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

export type RoutingSnapshot = z.infer<typeof snapshotSchema>;
export type StoredCombo = RoutingSnapshot["combos"][number];
export type StoredMapping = RoutingSnapshot["mappings"][number];
export const MAX_ROUTING_SNAPSHOT_BYTES = 1024 * 1024;

export const emptyRoutingSnapshot = (): RoutingSnapshot => ({
  schemaVersion: 1,
  combos: [],
  mappings: [],
  pendingCleanup: [],
});

export function parseRoutingSnapshot(data: string): RoutingSnapshot {
  try {
    if (Buffer.byteLength(data) > MAX_ROUTING_SNAPSHOT_BYTES) throw new Error();
    const snapshot = snapshotSchema.parse(JSON.parse(data));
    const ids = new Set(snapshot.combos.map((row) => row.id));
    const names = new Set(snapshot.combos.map((row) => row.name));
    if (
      ids.size !== snapshot.combos.length ||
      names.size !== snapshot.combos.length ||
      new Set(snapshot.mappings.map((row) => row.id)).size !== snapshot.mappings.length ||
      snapshot.mappings.some((row) => !ids.has(row.comboId))
    )
      throw new Error();
    return snapshot;
  } catch {
    throw new RoutingStorageError("invalid_snapshot");
  }
}

export interface RoutingSnapshotStorage {
  load(): Promise<{ revision: number; data: string }>;
  compareAndSwap(revision: number, data: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface SnapshotChange<T> {
  result: T;
  changed: boolean;
}

/** One aggregate makes combo/mapping cascades and reorder atomic on both engines. */
export class RoutingSnapshotStore {
  constructor(readonly storage: RoutingSnapshotStorage) {}

  async read(): Promise<RoutingSnapshot> {
    const { data } = await this.storage.load();
    return parseRoutingSnapshot(data);
  }

  /** Idempotent local effects are acknowledged only after cleanup succeeds.
   * Single-node slice: this is recovery bookkeeping, not a distributed outbox.
   */
  async drainCleanup(cleanup: (id: string, name: string) => Promise<void>): Promise<void> {
    for (const entry of (await this.read()).pendingCleanup) {
      await cleanup(entry.id, entry.name);
      await this.mutate((state) => {
        const remaining = state.pendingCleanup.filter((item) => item.token !== entry.token);
        const changed = remaining.length !== state.pendingCleanup.length;
        state.pendingCleanup = remaining;
        return { result: undefined, changed };
      });
    }
  }

  async mutate<T>(operation: (snapshot: RoutingSnapshot) => SnapshotChange<T>): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { revision, data } = await this.storage.load();
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
        throw new RoutingStorageError("invalid_snapshot");
      }
      const snapshot = parseRoutingSnapshot(data);
      const { result, changed } = operation(snapshot);
      if (!changed) return result;
      const next = JSON.stringify(snapshot);
      parseRoutingSnapshot(next);
      // Retry only a confirmed CAS conflict. Transport failures can have ambiguous outcomes.
      if (await this.storage.compareAndSwap(revision, next)) return result;
    }
    throw new RoutingStorageError("conflict");
  }
}
