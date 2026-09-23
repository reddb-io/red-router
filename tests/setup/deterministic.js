// Deterministic test environment, loaded before every test file.
//
// - Each file gets its own HOME and DATA_DIR, so no test reads or writes the
//   developer's ~/.red-router and parallel workers never share a database.
// - The clock's timezone is fixed (UTC).
// - Nothing may leave the machine: connections to anything but loopback or a
//   local socket fail immediately with ERR_TEST_NETWORK_BLOCKED, instead of
//   passing or timing out depending on the network. A test that really needs
//   the internet is a live test (*.live.test.js, real/*.real.test.js) and runs
//   only with RR_TEST_LIVE=1.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const LIVE = process.env.RR_TEST_LIVE === "1";

process.env.TZ = "UTC";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
// XDG dirs from the host (CI runners set XDG_CONFIG_HOME) would point outside the sandbox.
for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
  delete process.env[name];
}
process.env.DATA_DIR = path.join(sandbox, "data");
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const LOCAL_HOSTS = new Set(["localhost", "0.0.0.0", "::", "::1", "[::1]"]);

function isLocal(options) {
  if (!options || typeof options !== "object") return true;
  if (options.path) return true; // unix socket / named pipe
  const host = options.host ?? options.hostname;
  if (host === undefined || host === null || host === "") return true; // defaults to localhost
  const h = String(host).toLowerCase();
  return LOCAL_HOSTS.has(h) || h.startsWith("127.") || h.endsWith(".localhost");
}

// net.connect()/tls.connect()/http(s) and fetch (undici) all end in Socket#connect,
// called either with an options object or with the normalized [options, cb] pair.
function connectOptions(args) {
  const first = args[0];
  if (Array.isArray(first)) return first[0];
  if (first && typeof first === "object") return first;
  if (typeof first === "string" && Number.isNaN(Number(first))) return { path: first };
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
}

if (!LIVE && !net.Socket.prototype.connect.__rrGuarded) {
  const original = net.Socket.prototype.connect;
  const guarded = function connect(...args) {
    const options = connectOptions(args);
    if (!isLocal(options)) {
      const target = `${options.host ?? options.hostname}:${options.port ?? ""}`;
      const error = new Error(
        `Network access blocked in tests (${target}). Mock the call, or make it a live test (*.live.test.js, RR_TEST_LIVE=1).`
      );
      error.code = "ERR_TEST_NETWORK_BLOCKED";
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return original.apply(this, args);
  };
  guarded.__rrGuarded = true;
  net.Socket.prototype.connect = guarded;
}
