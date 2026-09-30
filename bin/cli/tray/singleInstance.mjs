/**
 * One tray per machine and port, and always the one of the installed version.
 *
 * A tray is a separate process from the server, so nothing restarted it when RedRouter was upgraded:
 * the old one kept its old icon (and its old code) until the next login. A small lock file records
 * which tray is running and which version it is; a newer version replaces it, the same version does
 * not start a second icon.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../data-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

export function trayLockPath(dataDir = resolveDataDir()) {
  return join(dataDir, "tray.lock.json");
}

/** True when `pid` is a live process that looks like a RedRouter tray (not a recycled pid). */
export function defaultIsTrayAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("tray");
  } catch {
    // No /proc (macOS, Windows): a live pid is all we can tell.
    return true;
  }
}

export function readTrayLock(path, isAlive = defaultIsTrayAlive) {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (lock && Number.isInteger(lock.pid) && isAlive(lock.pid)) return lock;
  } catch {
    // no lock, or an unreadable one: treated as none
  }
  return null;
}

/**
 * Takes the tray lock for this process. A running tray of the same version and port is left alone
 * (`claimed: false`); an older or different one, or any when `replace` is set, is asked to stop first.
 */
export function claimTrayLock({
  path = trayLockPath(),
  port,
  version = installedVersion(),
  replace = false,
  pid = process.pid,
  isAlive = defaultIsTrayAlive,
  terminate = (target) => process.kill(target, "SIGTERM"),
} = {}) {
  const current = readTrayLock(path, isAlive);
  if (current && current.pid !== pid) {
    const same = current.version === version && current.port === port;
    if (same && !replace) return { claimed: false, reason: "already-running", pid: current.pid };
    try {
      terminate(current.pid);
    } catch {
      // already gone
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, port, version, startedAt: new Date().toISOString() }));
  return { claimed: true, replaced: current && current.pid !== pid ? current : null };
}

/** Removes the lock, but only when it is still ours (a replacement may already own it). */
export function releaseTrayLock(path = trayLockPath(), pid = process.pid) {
  try {
    if (!existsSync(path)) return;
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (lock?.pid === pid) rmSync(path, { force: true });
  } catch {
    // nothing to release
  }
}
