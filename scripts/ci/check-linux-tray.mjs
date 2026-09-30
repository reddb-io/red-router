import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { registeredTrayPids } from "../../bin/cli/tray/linuxService.mjs";

// CI-only runtime smoke: real systemd user manager, native systray2, Xvfb and a fixture watcher.
if (!process.env.CI || process.platform !== "linux")
  throw new Error("Run this desktop regression in Linux CI");
const root = process.cwd();
const uid = process.getuid();
const user = userInfo().username;
const dir = mkdtempSync(join(tmpdir(), "redrouter-desktop-"));
const env = {
  ...process.env,
  DISPLAY: ":99",
  XDG_RUNTIME_DIR: `/run/user/${uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  DATA_DIR: dir,
  OMNIROUTE_CLI_SKIP_REPO_ENV: "1",
};
const run = (command, args) =>
  execFileSync(command, args, { env, encoding: "utf8", timeout: 60_000 }).trim();
const service = "red-router-tray.service";
const children = [];
async function until(check, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value) return value;
    } catch {
      /* starting */
    }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
function snapshot() {
  if (run("systemctl", ["--user", "is-active", service]) !== "active") return null;
  const pid = Number(run("systemctl", ["--user", "show", service, "-p", "MainPID", "--value"]));
  const helper = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .map(Number)
    .find((child) => registeredTrayPids(run).includes(child));
  return helper ? { pid, helper } : null;
}
try {
  run("sudo", ["loginctl", "enable-linger", user]);
  run("sudo", ["systemctl", "start", `user@${uid}.service`]);
  children.push(spawn("Xvfb", [":99", "-screen", "0", "1024x768x24"], { env, stdio: "inherit" }));
  children.push(
    spawn("/usr/bin/python3", [join(root, "scripts/ci/tray-watcher.py")], { env, stdio: "inherit" })
  );
  await until(() => registeredTrayPids(run), "fixture watcher");
  run("systemctl", ["--user", "start", "graphical-session.target"]);
  const config = {
    unitPath: join(homedir(), ".config/systemd/user", service),
    nodePath: process.execPath,
    cliPath: join(root, "bin/omniroute.mjs"),
    dataDir: dir,
    port: 25050,
    env: {},
  };
  const installer = `const {installLinuxTrayService}=await import(${JSON.stringify(pathToFileURL(join(root, "bin/cli/tray/linuxService.mjs")).href)}); console.log(JSON.stringify(installLinuxTrayService(${JSON.stringify(config)})));`;
  // Deliberately omit DISPLAY from the installer API: unattended updates use the manager session.
  run("systemctl", ["--user", "import-environment", "DISPLAY"]);
  run("systemd-run", [
    "--user",
    "--unit=redrouter-tray-ci-installer",
    "--collect",
    "--wait",
    "--pipe",
    "--property=Type=oneshot",
    process.execPath,
    "--input-type=module",
    "-e",
    installer,
  ]);
  const first = await until(snapshot, "tray survives installer exit and registers");
  assert.match(readFileSync(`/proc/${first.pid}/cgroup`, "utf8"), /red-router-tray\.service/);
  assert.equal(JSON.parse(readFileSync(join(dir, "tray.lock.json"), "utf8")).pid, first.pid);
  console.log("PASS: native tray registered in its own service after installer exit");
  run(process.execPath, ["--input-type=module", "-e", installer]);
  assert.equal((await until(snapshot, "idempotent install")).pid, first.pid);
  process.kill(first.helper, "SIGKILL");
  const recovered = await until(() => {
    const state = snapshot();
    return state && state.pid !== first.pid ? state : null;
  }, "native helper recovery");
  assert.notEqual(recovered.helper, first.helper);
  console.log("PASS: native helper failure restarts and registers a single new tray");
} catch (error) {
  try {
    console.error(run("journalctl", ["--user", "-u", service, "--no-pager", "-n", "60"]));
  } catch {
    /* diagnostics best effort */
  }
  throw error;
} finally {
  try {
    run("systemctl", ["--user", "disable", "--now", service]);
  } catch {
    /* failed startup */
  }
  rmSync(join(homedir(), ".config/systemd/user", service), { force: true });
  for (const child of children) child.kill();
  rmSync(dir, { recursive: true, force: true });
}
