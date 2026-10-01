import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-recovery-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../src/lib/db/core.ts");
const { createRequiredRecoverySnapshot, replaceDatabaseFromFile } =
  await import("../../../src/lib/db/databaseRecovery.ts");
const { withDatabaseMaintenance, assertDatabaseAvailable, DatabaseMaintenanceError } =
  await import("../../../src/lib/db/maintenance.ts");
const { encryptFile, decryptFile } = await import("../../../bin/cli/recovery/crypto.mjs");
const { fileDigest, restoreBundle, recoveryEnvironment } =
  await import("../../../bin/cli/recovery/bundle.mjs");
const { withRestoreMaintenance } = await import("../../../bin/cli/recovery/maintenance.mjs");
const { backupSqliteFile } = await import("../../../bin/cli/sqlite.mjs");

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("encrypted recovery includes the effective storage key and restores with private permissions", async () => {
  const bundle = await fs.mkdtemp(join(dataDir, "bundle-"));
  const target = await fs.mkdtemp(join(dataDir, "target-"));
  const originalKey = process.env.STORAGE_ENCRYPTION_KEY;
  try {
    process.env.STORAGE_ENCRYPTION_KEY = "effective-test-storage-key";
    await fs.writeFile(join(target, ".env"), "STORAGE_ENCRYPTION_KEY=old\nPORT=25050\n");
    const content = await recoveryEnvironment(target);
    assert.ok(content.includes("effective-test-storage-key"));
    assert.ok(!content.includes("KEY=old"));
    const source = join(bundle, "source");
    await fs.writeFile(source, content);
    await encryptFile(source, join(bundle, ".env.enc"), "backup-passphrase");
    const digest = await fileDigest(join(bundle, ".env.enc"));
    await fs.writeFile(
      join(bundle, "backup-info.json"),
      JSON.stringify({
        encrypted: true,
        files: [".env.enc"],
        checksums: { ".env.enc": digest },
      })
    );
    let stopped = false;
    const result = await restoreBundle(bundle, target, "backup-passphrase", {
      withMaintenance: async (_dir: string, operation: () => Promise<unknown>) => {
        assert.equal(
          await fs.readFile(join(target, ".env"), "utf8"),
          "STORAGE_ENCRYPTION_KEY=old\nPORT=25050\n"
        );
        stopped = true;
        return operation();
      },
    });
    assert.equal(stopped, true);
    assert.deepEqual(result.files, [".env"]);
    assert.equal(await fs.readFile(join(target, ".env"), "utf8"), content);
    assert.match(await fs.readFile(join(result.recoverySnapshot, ".env"), "utf8"), /KEY=old/);
    if (process.platform !== "win32")
      assert.equal((await fs.stat(join(target, ".env"))).mode & 0o777, 0o600);
    assert.ok(
      !(await fs.readFile(join(bundle, ".env.enc"))).includes(
        Buffer.from("effective-test-storage-key")
      )
    );
  } finally {
    if (originalKey === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
    else process.env.STORAGE_ENCRYPTION_KEY = originalKey;
  }
});

test("wrong password, tampered ciphertext, checksum mismatch and duplicate files never change destination", async () => {
  const bundle = await fs.mkdtemp(join(dataDir, "bad-bundle-"));
  const target = await fs.mkdtemp(join(dataDir, "unchanged-"));
  const source = join(bundle, "source");
  await fs.writeFile(source, "new settings");
  await fs.writeFile(join(target, "settings.json"), "original settings");
  const encrypted = join(bundle, "settings.json.enc");
  await encryptFile(source, encrypted, "correct");
  const manifest = { encrypted: true, files: ["settings.json.enc"], checksums: {} };
  const writeManifest = () =>
    fs.writeFile(join(bundle, "backup-info.json"), JSON.stringify(manifest));
  await writeManifest();
  let maintenanceCalls = 0;
  const dependencies = {
    withMaintenance: async () => {
      maintenanceCalls++;
      throw new Error("must not pause");
    },
  };
  await assert.rejects(
    restoreBundle(bundle, target, "wrong", dependencies),
    /authentication failed/
  );
  const damaged = await fs.readFile(encrypted);
  damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(encrypted, damaged);
  await assert.rejects(
    decryptFile(encrypted, join(bundle, "plaintext"), "correct"),
    /authentication failed/
  );
  await assert.rejects(fs.stat(join(bundle, "plaintext")), { code: "ENOENT" });
  manifest.checksums = { "settings.json.enc": "incorrect" };
  await writeManifest();
  await assert.rejects(restoreBundle(bundle, target, "correct", dependencies), /checksum mismatch/);
  await encryptFile(source, encrypted, "correct");
  manifest.checksums = {};
  manifest.files.push("settings.json.enc");
  await writeManifest();
  await assert.rejects(
    restoreBundle(bundle, target, "correct", dependencies),
    /Invalid backup manifest/
  );
  assert.equal(maintenanceCalls, 0);
  assert.equal(await fs.readFile(join(target, "settings.json"), "utf8"), "original settings");
  assert.ok(!(await fs.readdir(target)).some((name) => name.startsWith(".restore-")));
});

test("managed restore stops its owning service and restarts even after operation failure", async () => {
  const directory = await fs.mkdtemp(join(dataDir, "managed-"));
  await fs.mkdir(join(directory, "supervisor"));
  await fs.writeFile(join(directory, "supervisor", ".pid"), "123");
  const events: string[] = [];
  let running = true;
  const dependencies = {
    platform: "linux",
    isPidRunning: () => running,
    runSystemd: (args: string[]) => {
      events.push(args[0]);
      if (args[0] === "show") return "123";
      running = args[0] === "start";
      return "";
    },
  };
  await assert.rejects(
    withRestoreMaintenance(
      directory,
      async () => {
        assert.equal(running, false);
        events.push("restore");
        throw new Error("installation failed");
      },
      dependencies
    ),
    /installation failed/
  );
  assert.deepEqual(events, ["show", "stop", "restore", "start"]);
  let modified = false;
  await assert.rejects(
    withRestoreMaintenance(
      directory,
      async () => {
        modified = true;
      },
      {
        ...dependencies,
        runSystemd: () => "999",
      }
    ),
    /Stop the RedRouter server/
  );
  assert.equal(modified, false);
});

test("restore refuses a server holding SQLite without CLI PID files", async () => {
  const directory = await fs.mkdtemp(join(dataDir, "unmanaged-"));
  let modified = false;
  await assert.rejects(
    withRestoreMaintenance(
      directory,
      async () => {
        modified = true;
      },
      {
        platform: "linux",
        isPidRunning: () => false,
        findOpenDatabasePids: () => [555],
        runSystemd: () => "999",
      }
    ),
    /Stop the RedRouter server/
  );
  assert.equal(modified, false);
});

test("mandatory snapshot works with auto backup disabled and rejected replacement restores original rows", async () => {
  const db = core.getDbInstance();
  db.exec(
    "CREATE TABLE recovery_probe(value TEXT); INSERT INTO recovery_probe VALUES ('original')"
  );
  const snapshot = await createRequiredRecoverySnapshot("pre-import");
  assert.ok((await fs.stat(snapshot)).size >= 4096);
  db.prepare("UPDATE recovery_probe SET value = 'replacement'").run();
  const replacement = join(dataDir, "replacement.sqlite");
  await backupSqliteFile(core.SQLITE_FILE, replacement);
  db.prepare("UPDATE recovery_probe SET value = 'original'").run();
  await assert.rejects(
    replaceDatabaseFromFile(replacement, "pre-restore", () => {
      assert.deepEqual(core.getDbInstance().prepare("SELECT value FROM recovery_probe").get(), {
        value: "replacement",
      });
      throw new Error("verification rejected");
    }),
    /verification rejected/
  );
  assert.deepEqual(core.getDbInstance().prepare("SELECT value FROM recovery_probe").get(), {
    value: "original",
  });
  assert.ok(!(await fs.readdir(dataDir)).some((name) => name.startsWith(".recovery-")));
});

test("database maintenance rejects competing DB access and concurrent restore, then releases the lock", async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = withDatabaseMaintenance(async () => {
    assertDatabaseAvailable();
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  assert.throws(() => core.getDbInstance(), DatabaseMaintenanceError);
  await assert.rejects(
    withDatabaseMaintenance(async () => undefined),
    DatabaseMaintenanceError
  );
  release();
  await pending;
  assert.doesNotThrow(() => core.getDbInstance());
});
