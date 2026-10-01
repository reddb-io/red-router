import { AsyncLocalStorage } from "node:async_hooks";

// Share the lock across server bundles and development reloads in this process.
const shared = globalThis as typeof globalThis & {
  __redRouterRecoveryLock?: { context: AsyncLocalStorage<symbol>; owner: symbol | null };
};
const lock = (shared.__redRouterRecoveryLock ??= {
  context: new AsyncLocalStorage<symbol>(),
  owner: null,
});

export class DatabaseMaintenanceError extends Error {
  constructor() {
    super("Database recovery is in progress. Retry after it completes.");
  }
}

export function assertDatabaseAvailable(): void {
  if (lock.owner && lock.context.getStore() !== lock.owner) throw new DatabaseMaintenanceError();
}

/** Only the replacement operation can reopen SQLite while its files are being replaced. */
export async function withDatabaseMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  if (lock.owner) throw new DatabaseMaintenanceError();
  const token = Symbol("database-recovery");
  lock.owner = token;
  try {
    return await lock.context.run(token, operation);
  } finally {
    lock.owner = null;
  }
}
