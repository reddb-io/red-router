import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Runs only in CI against its own user-service fixture. Exercise the real systemd
// queue and real socket bind, including a request through the runner's LAN address.
const { uid, username } = userInfo();
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: `/run/user/${uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
};
const run = (command, args) =>
  execFileSync(command, args, { env, encoding: "utf8", timeout: 15000 }).trim();
const root = process.cwd();
const unit = join(homedir(), ".config/systemd/user/red-router.service");
assert.equal(existsSync(unit), false, "the runner must not have an existing router service");
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-network-ci-"));
const port = 26000 + (process.pid % 2000);
const address = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
assert.ok(address, "runner must have an IPv4 network interface");
const quote = (value) =>
  `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const original = `[Unit]\nDescription=RedRouter AI routing gateway\n[Service]\nType=simple\nExecStart=${[process.execPath, "--import", "tsx/esm", join(root, "tests/redrouter/fixtures/network-listener.mjs"), "serve", "--port", String(port), "--host", "127.0.0.1", "--no-open"].map(quote).join(" ")}\nWorkingDirectory=${quote(root)}\nEnvironment=${quote("PORT=" + port)}\nEnvironment=${quote("RED_ROUTER_PORT=" + port)}\nEnvironment="RED_ROUTER_SERVER_HOST=127.0.0.1"\nEnvironment=${quote("DATA_DIR=" + dataDir)}\nEnvironment=${quote("XDG_RUNTIME_DIR=" + env.XDG_RUNTIME_DIR)}\nEnvironment=${quote("DBUS_SESSION_BUS_ADDRESS=" + env.DBUS_SESSION_BUS_ADDRESS)}\nRestart=on-failure\n`;
async function status(host = "127.0.0.1") {
  const response = await fetch(`http://${host}:${port}/network`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* restarting */
    }
    await delay(250);
  }
  throw new Error("Network listener readiness deadline exceeded");
}
async function reachable(host) {
  try {
    await status(host);
    return true;
  } catch {
    return false;
  }
}
async function change(mode) {
  const response = await fetch(`http://127.0.0.1:${port}/network`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  assert.equal(response.status, 200);
}
try {
  run("sudo", ["loginctl", "enable-linger", username]);
  run("sudo", ["systemctl", "start", `user@${uid}.service`]);
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, original);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "start", "red-router.service"]);
  const first = await until(() => status());
  assert.equal(first.managed, true);
  assert.equal(await reachable(address), false, "loopback listener must not answer over LAN");
  await change("lan");
  const lan = await until(async () => {
    const result = await status(address);
    return result.pid !== first.pid && result.mode === "lan" && !result.pendingRestart && result;
  });
  assert.equal(lan.host, "0.0.0.0");
  await change("local");
  await until(async () => {
    const result = await status();
    return result.pid !== lan.pid && result.mode === "local" && !result.pendingRestart && result;
  });
  assert.equal(await reachable(address), false, "returning to loopback must close LAN access");
  assert.equal(
    readFileSync(unit, "utf8"),
    original,
    "port, paths and other unit settings survive the round trip"
  );
  console.log(
    "Network access: real service restart, LAN reachability and return to loopback passed"
  );
} catch (error) {
  try {
    console.error(
      run("journalctl", ["--user", "-u", "red-router.service", "--no-pager", "-n", "40"])
    );
  } catch {
    /* diagnostics */
  }
  throw error;
} finally {
  try {
    run("systemctl", ["--user", "stop", "red-router.service"]);
  } catch {
    /* fixture failed */
  }
  rmSync(unit, { force: true });
  rmSync(dataDir, { recursive: true, force: true });
}
