import os from "node:os";
import path from "node:path";

const UPSTREAM_APP_NAME = "omniroute";

function normalizeConfiguredPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  }
}

export function getLegacyDotDataDir(homeDir = safeHomeDir()) {
  return path.join(homeDir, `.${UPSTREAM_APP_NAME}`);
}

export function getDefaultDataDir() {
  const homeDir = safeHomeDir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "red", "router");
  }

  return path.join(homeDir, ".red", "router");
}

export function resolveDataDir() {
  const configured = normalizeConfiguredPath(
    process.env.RED_ROUTER_DATA_DIR || process.env.DATA_DIR
  );
  if (configured) return configured;

  return getDefaultDataDir();
}

export function resolveStoragePath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "storage.sqlite");
}
