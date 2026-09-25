// Network access: which address the gateway binds (local 127.0.0.1 or network
// 0.0.0.0). Saved in <data dir>/network.json and read by the CLI launcher when it
// starts the server; keep the file format in step with cli/src/cli/network.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const NETWORK_MODES = { local: "127.0.0.1", network: "0.0.0.0" };
// The launcher starts the server again, on the saved address, when it exits with this.
export const RESTART_EXIT_CODE = 75;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export const networkSettingPath = (dir = DATA_DIR) => path.join(dir, "network.json");

/** The saved mode ("local" | "network"), or null. */
export function readNetworkMode(dir = DATA_DIR) {
  try {
    const mode = JSON.parse(fs.readFileSync(networkSettingPath(dir), "utf8"))?.mode;
    return Object.hasOwn(NETWORK_MODES, mode) ? mode : null;
  } catch {
    return null;
  }
}

export function writeNetworkMode(mode, dir = DATA_DIR) {
  if (!Object.hasOwn(NETWORK_MODES, mode)) throw new Error(`Unknown network mode "${mode}"`);
  const file = networkSettingPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** IPv4 addresses other devices can use to reach this machine. */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

/**
 * What this server is bound to now, where that came from, and what the saved
 * setting would change.
 *   source: "flag" (--host for this run), "setting", "default" (launcher default),
 *           "env" (HOSTNAME, no launcher), "unknown"
 *   canRestart: the CLI launcher runs this server and restarts it on request
 */
export function networkStatus({ env = process.env, dir = DATA_DIR, interfaces } = {}) {
  const host = env.HOSTNAME || "0.0.0.0";
  const launcher = env.RED_ROUTER_LAUNCHER === "1";
  const source = launcher ? env.RED_ROUTER_HOST_SOURCE || "unknown" : (env.HOSTNAME ? "env" : "unknown");
  const exposed = !LOOPBACK.has(host);
  const port = Number(env.PORT) || 25050;
  const mode = readNetworkMode(dir);
  const addresses = host === "0.0.0.0" ? lanAddresses(interfaces) : exposed ? [host] : [];
  return {
    mode,
    host,
    port,
    exposed,
    source,
    canRestart: launcher,
    // A flag or HOSTNAME outside the launcher overrides the setting until removed.
    pinned: source === "flag" || source === "env",
    // The saved setting differs from what is bound now: a restart applies it.
    pending: mode !== null && NETWORK_MODES[mode] !== host && source !== "flag",
    urls: addresses.map((a) => `http://${a}:${port}`),
  };
}
