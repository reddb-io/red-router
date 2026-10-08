import {
  emptyRoutingSnapshot,
  type RoutingSnapshotStorage,
} from "../../../src/lib/db/repositories/routingSnapshotStore.ts";

export class MemoryRoutingStorage implements RoutingSnapshotStorage {
  revision = 0;
  data = JSON.stringify(emptyRoutingSnapshot());
  writes = 0;
  async load() {
    return { revision: this.revision, data: this.data };
  }
  async compareAndSwap(revision: number, data: string) {
    this.writes++;
    if (revision !== this.revision) return false;
    this.data = data;
    this.revision++;
    return true;
  }
  async close() {}
}
