import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, SQLITE_FILE, getDbInstance, resetDbInstance } from "./core";
import { withDatabaseMaintenance } from "./maintenance";

type RecoveryReason = "pre-import" | "pre-restore";

/** Mandatory recovery snapshots never consult automatic-backup flags, throttling or retention. */
export async function createRequiredRecoverySnapshot(reason: RecoveryReason): Promise<string> {
  if (!SQLITE_FILE) throw new Error("Database recovery requires local SQLite storage");
  const directory = path.join(DATA_DIR, "db_backups");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(
    directory,
    `db_${new Date().toISOString().replace(/[:.]/g, "-")}_${reason}_${randomUUID()}.sqlite`
  );
  await getDbInstance().backup(file);
  await fs.chmod(file, 0o600);
  if ((await fs.stat(file)).size < 4096) throw new Error("Recovery snapshot is incomplete");
  return file;
}

async function retryBusy(operation: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== "EBUSY" && code !== "EPERM")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function removeSidecars(file: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"])
    await retryBusy(() => fs.rm(file + suffix, { force: true }));
}

export async function replaceDatabaseFromFile<T>(
  source: string,
  reason: RecoveryReason,
  verify: () => T
): Promise<{ result: T; recoverySnapshot: string }> {
  return withDatabaseMaintenance(async () => {
    if (!SQLITE_FILE) throw new Error("Database recovery requires local SQLite storage");
    const destination = SQLITE_FILE;
    const staging = path.join(DATA_DIR, `.recovery-${randomUUID()}.sqlite`);
    // Prepare the replacement before pausing SQLite, on the same filesystem as the destination.
    try {
      await fs.copyFile(source, staging);
      await fs.chmod(staging, 0o600);
      const recoverySnapshot = await createRequiredRecoverySnapshot(reason);
      resetDbInstance();
      try {
        await removeSidecars(destination);
        await retryBusy(() => fs.rename(staging, destination));
        getDbInstance();
        return { result: verify(), recoverySnapshot };
      } catch (error) {
        resetDbInstance();
        await removeSidecars(destination);
        await fs.copyFile(recoverySnapshot, destination);
        await fs.chmod(destination, 0o600);
        getDbInstance();
        throw error;
      }
    } finally {
      await fs.rm(staging, { force: true });
    }
  });
}
