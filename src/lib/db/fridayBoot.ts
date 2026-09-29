/**
 * db/fridayBoot.ts — first-boot hook that brings RedRouter v0.33.0 data into this database.
 *
 * Runs once the SQLite singleton is ready. It imports only into an EMPTY install (no
 * connections, keys or combos): an install that already holds data is left alone and the
 * operator is told how to import on purpose. It never throws — a failed import is logged and
 * retried on the next boot, because no marker is written until the import completes.
 */

import { getDbInstance } from "./core";
import { fridayImportPending, importFridayData } from "./fridayImport";
import { resolveDataDir } from "../dataPaths";

interface CountRow {
  count: number;
}

function installIsEmpty(): boolean {
  const db = getDbInstance();
  return ["provider_connections", "api_keys", "combos"].every((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
    return row.count === 0;
  });
}

export async function importFridayDataOnFirstBoot(
  log: Pick<Console, "log" | "warn"> = console
): Promise<void> {
  try {
    const dataDir = resolveDataDir();
    if (!fridayImportPending(dataDir)) return;
    if (!installIsEmpty()) {
      log.warn(
        "[FRIDAY-IMPORT] RedRouter v0.33.0 data was found but this install already has data; " +
          "skipping the automatic import"
      );
      return;
    }
    const report = await importFridayData({ dataDir });
    log.log(
      `[FRIDAY-IMPORT] Imported ${report.imported.connections} connections, ` +
        `${report.imported.apiKeys} API keys, ${report.imported.combos} combos and ` +
        `${report.imported.usageHistory} usage rows from ${report.source}. ` +
        `Backup: ${report.backup}. Not yet mapped: ${JSON.stringify(report.notMapped)}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[FRIDAY-IMPORT] Import failed and will be retried on the next start: ${message}`);
  }
}
