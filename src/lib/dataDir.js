import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "red-router";
const LEGACY_APP_NAME = "9router";

function legacyDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

// One-time migration from the pre-rebrand legacy data dir. Renames the whole
// dir when the target does not exist yet; otherwise moves top-level entries
// that are not already present (runtime/ may exist here first via postinstall).
// Fail-open: any error keeps the new dir in use without legacy data.
function migrateLegacyDataDir(dir) {
  try {
    const legacy = legacyDir();
    if (!fs.existsSync(legacy)) return dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(legacy, dir);
      console.log(`[DATA_DIR] migrated legacy data ${legacy} → ${dir}`);
      return dir;
    }
    let moved = 0;
    for (const entry of fs.readdirSync(legacy)) {
      const from = path.join(legacy, entry);
      const to = path.join(dir, entry);
      if (fs.existsSync(to)) continue;
      fs.renameSync(from, to);
      moved++;
    }
    if (moved > 0) console.log(`[DATA_DIR] migrated ${moved} legacy item(s) ${legacy} → ${dir}`);
    if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
  } catch (e) {
    console.warn(`[DATA_DIR] legacy migration skipped: ${e?.message}`);
  }
  return dir;
}

function defaultDir() {
  const dir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME)
    : path.join(os.homedir(), `.${APP_NAME}`);
  return migrateLegacyDataDir(dir);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
