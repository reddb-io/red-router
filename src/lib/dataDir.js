import fs from "node:fs";
import path from "path";
import os from "os";

// Data lives under ~/.red/router — matching the .red/* ecosystem layout
// (.red/code, .red/router). One-time migrations into the new dir, in priority
// order: ~/.red-router (previous RedRouter layout) and ~/.9router (the
// official 9router origin). Fail-open: any error keeps the new dir in use
// without legacy data.
const LEGACY_DIR_NAMES = ["red-router", "9router"];

export function buildDefaultDataDir({ homedir = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") {
    const root = process.env.APPDATA || path.join(homedir, "AppData", "Roaming");
    return path.join(root, "red", "router");
  }
  return path.join(homedir, ".red", "router");
}

export function buildLegacyDataDirs({ homedir = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32") {
    const root = process.env.APPDATA || path.join(homedir, "AppData", "Roaming");
    return LEGACY_DIR_NAMES.map((name) => path.join(root, name));
  }
  return LEGACY_DIR_NAMES.map((name) => path.join(homedir, `.${name}`));
}

// One-time migration. Renames the newest legacy dir when the target does not
// exist yet; otherwise moves top-level entries that are not already present
// (runtime/ may exist in the target first via postinstall). Empty legacy dirs
// are removed afterwards.
export function migrateLegacyDataDirs(dir, { homedir = os.homedir(), platform = process.platform, log = console } = {}) {
  try {
    const legacies = buildLegacyDataDirs({ homedir, platform }).filter((legacy) => fs.existsSync(legacy));
    if (legacies.length === 0) return dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(legacies[0], dir);
      log.log?.(`[DATA_DIR] migrated legacy data ${legacies[0]} → ${dir}`);
      legacies.shift();
    }
    for (const legacy of legacies) {
      let moved = 0;
      for (const entry of fs.readdirSync(legacy)) {
        const from = path.join(legacy, entry);
        const to = path.join(dir, entry);
        if (fs.existsSync(to)) continue;
        fs.renameSync(from, to);
        moved++;
      }
      if (moved > 0) log.log?.(`[DATA_DIR] migrated ${moved} item(s) ${legacy} → ${dir}`);
      if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    }
  } catch (e) {
    log.warn?.(`[DATA_DIR] legacy migration skipped: ${e?.message}`);
  }
  return dir;
}

function defaultDir() {
  return migrateLegacyDataDirs(buildDefaultDataDir());
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
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback to ${buildDefaultDataDir()}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
