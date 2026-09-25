/**
 * Network access: which address the gateway binds.
 *   local   — 127.0.0.1, this machine only
 *   network — 0.0.0.0, every device that can reach this machine
 *
 * The choice is saved in <data dir>/network.json, written by the dashboard
 * (Profile → Network access) or `red-router network local|network`, and read by
 * the launcher each time it starts the server. A `--host`/`--expose`/`--local`
 * flag wins over it for that run.
 *
 * Keep the file format in step with src/lib/networkAccess.js.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MODES = { local: "127.0.0.1", network: "0.0.0.0" };
// The server exits with this code to be started again with the saved setting.
const RESTART_EXIT_CODE = 75;

function dataDir(env = process.env) {
  if (env.DATA_DIR) return env.DATA_DIR;
  return process.platform === "win32"
    ? path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "red", "router")
    : path.join(os.homedir(), ".red", "router");
}

const settingPath = (env = process.env) => path.join(dataDir(env), "network.json");

/** The saved mode ("local" | "network"), or null when none is saved or the file is unreadable. */
function readNetworkMode(env = process.env) {
  try {
    const mode = JSON.parse(fs.readFileSync(settingPath(env), "utf8"))?.mode;
    return Object.hasOwn(MODES, mode) ? mode : null;
  } catch {
    return null;
  }
}

function writeNetworkMode(mode, env = process.env) {
  if (!Object.hasOwn(MODES, mode)) throw new Error(`Unknown network mode "${mode}" (use local or network)`);
  const file = settingPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * The address to bind and why: a flag for this run, else the saved setting,
 * else the launcher's default.
 * @returns {{ host: string, source: "flag"|"setting"|"default" }}
 */
function resolveHost({ flagHost = null, defaultHost, env = process.env } = {}) {
  if (flagHost) return { host: flagHost, source: "flag" };
  const mode = readNetworkMode(env);
  if (mode) return { host: MODES[mode], source: "setting" };
  return { host: defaultHost, source: "default" };
}

module.exports = { MODES, RESTART_EXIT_CODE, dataDir, settingPath, readNetworkMode, writeNetworkMode, resolveHost };
