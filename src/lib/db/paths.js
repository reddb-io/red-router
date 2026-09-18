import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

// data.sqlite lives directly in the data dir (~/.red/router/data.sqlite).
export const DB_DIR = DATA_DIR;
export const DATA_FILE = path.join(DATA_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");

// Pre-0.7 layout kept data.sqlite under DATA_DIR/db/ — relocate one-time so
// existing installs land on ~/.red/router/data.sqlite without losing data.
export function relocateLegacyDbLayout(dir = DATA_DIR) {
  try {
    const legacyDbDir = path.join(dir, "db");
    const legacyDbFile = path.join(legacyDbDir, "data.sqlite");
    const target = path.join(dir, "data.sqlite");
    const backups = path.join(dir, "backups");
    if (!fs.existsSync(legacyDbFile) || fs.existsSync(target)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(legacyDbFile, target);
    const legacyBackups = path.join(legacyDbDir, "backups");
    if (fs.existsSync(legacyBackups) && !fs.existsSync(backups)) {
      fs.renameSync(legacyBackups, backups);
    }
    try {
      fs.rmdirSync(legacyDbDir);
    } catch {}
    console.log(`[DB] relocated legacy layout: ${legacyDbFile} → ${target}`);
    return true;
  } catch (e) {
    console.warn(`[DB] legacy layout relocation skipped: ${e?.message}`);
    return false;
  }
}

export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};

export function ensureDirs() {
  relocateLegacyDbLayout();
  for (const dir of [DATA_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
