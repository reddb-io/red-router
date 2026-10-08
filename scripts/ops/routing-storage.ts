import fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  readRoutingStorageConfig,
  RoutingStorageError,
} from "../../src/lib/db/repositories/routingStorageConfig.ts";
import { PgRoutingSnapshotStorage } from "../../src/lib/db/repositories/pgRoutingSnapshotStorage.ts";
import {
  MAX_ROUTING_SNAPSHOT_BYTES,
  parseRoutingSnapshot,
} from "../../src/lib/db/repositories/routingSnapshotStore.ts";
import {
  exportSqliteRoutingSnapshot,
  importEmptyRoutingSnapshot,
} from "../../src/lib/db/repositories/routingStorageMaintenance.ts";

const [command, ...args] = process.argv.slice(2);
const maintenance = args.includes("--maintenance");
const file = args.filter((arg) => arg !== "--maintenance")[0];
let storage: PgRoutingSnapshotStorage | undefined;
try {
  if (
    !maintenance ||
    !["initialize", "export", "export-sqlite", "import-empty"].includes(command)
  ) {
    throw new Error(
      "Stop every application writer, then use initialize | export FILE | export-sqlite FILE | import-empty FILE with --maintenance"
    );
  }
  if (
    command !== "initialize" &&
    (!file || args.filter((arg) => arg !== "--maintenance").length !== 1)
  ) {
    throw new Error("Exactly one snapshot file is required");
  }
  let data: string | undefined;
  if (command === "export-sqlite") {
    data = await exportSqliteRoutingSnapshot();
  } else {
    const config = readRoutingStorageConfig();
    if (config.backend === "sqlite") throw new RoutingStorageError("configuration");
    storage = new PgRoutingSnapshotStorage(config);
    if (command === "initialize") await storage.initialize();
    if (command === "export") {
      data = (await storage.load()).data;
      parseRoutingSnapshot(data);
    }
    if (command === "import-empty") {
      const handle = await fs.open(file!, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_ROUTING_SNAPSHOT_BYTES)
          throw new RoutingStorageError("invalid_snapshot");
        await importEmptyRoutingSnapshot(storage, await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
    }
  }
  if (data !== undefined) {
    const handle = await fs.open(
      file!,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  console.log("Routing storage maintenance completed");
} catch (error) {
  // File paths and driver errors may contain secrets; emit fixed diagnostics only.
  console.error(
    error instanceof RoutingStorageError
      ? error.message
      : "Routing storage maintenance failed; check command, maintenance mode and file permissions"
  );
  process.exitCode = 1;
} finally {
  try {
    await storage?.close();
  } catch {
    console.error("Routing storage shutdown failed");
    process.exitCode = 1;
  }
}
