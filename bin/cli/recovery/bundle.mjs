import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { decryptFile } from "./crypto.mjs";
import { backupSqliteFile, readDatabaseHealth } from "../sqlite.mjs";
import { withRestoreMaintenance } from "./maintenance.mjs";

export const BACKUP_FILES = ["storage.sqlite", "settings.json", "combos.json", "providers.json"];
const RESTORE_FILES = new Set([...BACKUP_FILES, ".env"]);

export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Capture the effective storage key only inside an encrypted bundle. Never log its value. */
export async function recoveryEnvironment(dataDir) {
  let content = "";
  try {
    content = await fs.readFile(join(dataDir, ".env"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (secret) {
    content = content.replace(/^\s*STORAGE_ENCRYPTION_KEY=.*$/gm, "");
    content += `\nSTORAGE_ENCRYPTION_KEY=${JSON.stringify(secret)}\n`;
  }
  return content;
}

export async function restoreBundle(backupPath, dataDir, passphrase, dependencies = {}) {
  const info = JSON.parse(await fs.readFile(join(backupPath, "backup-info.json"), "utf8"));
  if (!Array.isArray(info.files) || !info.files.length)
    throw new Error("Backup has no restorable files");
  await fs.mkdir(dataDir, { recursive: true });
  const stage = await fs.mkdtemp(join(dataDir, ".restore-"));
  await fs.chmod(stage, 0o700);
  const names = [];
  try {
    // Verify/decrypt every file BEFORE pausing the service or modifying destination files.
    for (const storedName of info.files) {
      if (typeof storedName !== "string") throw new Error("Invalid backup manifest");
      const name = info.encrypted ? storedName.replace(/\.enc$/, "") : storedName;
      if (
        !RESTORE_FILES.has(name) ||
        names.includes(name) ||
        (info.encrypted && !storedName.endsWith(".enc"))
      ) {
        throw new Error("Invalid backup manifest file");
      }
      const source = join(backupPath, storedName);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Backup file must be a regular file");
      if (
        info.checksums?.[storedName] &&
        (await fileDigest(source)) !== info.checksums[storedName]
      ) {
        throw new Error("Backup checksum mismatch");
      }
      const destination = join(stage, name);
      if (info.encrypted) await decryptFile(source, destination, passphrase);
      else await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o600);
      names.push(name);
    }
    if (names.includes("storage.sqlite")) {
      const health = await readDatabaseHealth(join(stage, "storage.sqlite"));
      if (health.quickCheckValue !== "ok") throw new Error("Backup SQLite integrity check failed");
    }
    const maintenance = dependencies.withMaintenance ?? withRestoreMaintenance;
    return await maintenance(dataDir, async () => {
      const rollback = await fs.mkdtemp(join(dataDir, ".pre-restore-"));
      await fs.chmod(rollback, 0o700);
      const originals = new Set();
      const installed = [];
      try {
        for (const name of names) {
          const source = join(dataDir, name);
          try {
            await fs.stat(source);
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          if (name === "storage.sqlite") await backupSqliteFile(source, join(rollback, name));
          else await fs.copyFile(source, join(rollback, name));
          await fs.chmod(join(rollback, name), 0o600);
          originals.add(name);
        }
        for (const name of names) {
          if (name === "storage.sqlite") {
            // Track the DB before deleting sidecars, so a later rename failure restores it too.
            installed.push(name);
            for (const suffix of ["-wal", "-shm", "-journal"])
              await fs.rm(join(dataDir, name + suffix), { force: true });
          }
          await fs.rename(join(stage, name), join(dataDir, name));
          if (name !== "storage.sqlite") installed.push(name);
        }
        return { files: names, recoverySnapshot: rollback };
      } catch (error) {
        for (const name of installed.reverse()) {
          if (originals.has(name)) await fs.copyFile(join(rollback, name), join(dataDir, name));
          else await fs.rm(join(dataDir, name), { force: true });
        }
        throw error;
      }
    });
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
