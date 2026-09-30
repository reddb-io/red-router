import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LINUX_TRAY_SERVICE_NAME = "red-router-tray.service";
const MANAGED_MARKER = "# Managed by RedRouter";
const SESSION_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP"];

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function runSystemCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

export function buildLinuxTrayUnit({ nodePath, cliPath, dataDir, port }) {
  const args = [
    nodePath,
    cliPath,
    "tray",
    "attach",
    "--port",
    String(port),
    "--replace",
    "--managed",
  ];
  return [
    MANAGED_MARKER,
    "[Unit]",
    "Description=RedRouter system tray",
    "PartOf=graphical-session.target",
    "After=graphical-session.target dbus.socket",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=notify",
    "NotifyAccess=all",
    "TimeoutStartSec=90",
    `ExecStart=${args.map(quote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=control-group",
    `Environment=${quote(`DATA_DIR=${dataDir}`)}`,
    "Environment=OMNIROUTE_CLI_SKIP_REPO_ENV=1",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=graphical-session.target",
    "",
  ].join("\n");
}

export function startLinuxTrayService({
  env = process.env,
  replace = false,
  run = runSystemCommand,
} = {}) {
  if (env.RED_ROUTER_TRAY === "0") {
    run("systemctl", ["--user", "stop", LINUX_TRAY_SERVICE_NAME]);
    return { state: "disabled", unit: LINUX_TRAY_SERVICE_NAME };
  }
  // The desktop autostart supplies the session environment. An unattended update can instead
  // use the user manager's existing environment without inheriting the updater's cgroup.
  const variables = SESSION_VARIABLES.filter((key) => env[key]);
  if (variables.length) run("systemctl", ["--user", "import-environment", ...variables]);
  if (!variables.some((key) => key === "DISPLAY" || key === "WAYLAND_DISPLAY")) {
    let graphical = false;
    try {
      graphical =
        run("systemctl", ["--user", "is-active", "graphical-session.target"]) === "active";
    } catch {
      // Installation on a headless host still enables startup for a future desktop login.
    }
    if (!graphical) return { state: "waiting-for-desktop", unit: LINUX_TRAY_SERVICE_NAME };
  }
  run("systemctl", [
    "--user",
    "--no-block",
    replace ? "restart" : "start",
    LINUX_TRAY_SERVICE_NAME,
  ]);
  return { state: "starting", unit: LINUX_TRAY_SERVICE_NAME };
}

export function installLinuxTrayService({
  unitPath,
  env = process.env,
  run = runSystemCommand,
  ...config
}) {
  if (existsSync(unitPath) && !readFileSync(unitPath, "utf8").startsWith(MANAGED_MARKER)) {
    return { state: "unmanaged", unit: LINUX_TRAY_SERVICE_NAME };
  }
  if (env.RED_ROUTER_TRAY === "0") {
    if (existsSync(unitPath)) {
      run("systemctl", ["--user", "disable", "--now", LINUX_TRAY_SERVICE_NAME]);
      rmSync(unitPath);
      run("systemctl", ["--user", "daemon-reload"]);
    }
    return { state: "disabled", unit: LINUX_TRAY_SERVICE_NAME };
  }
  const unit = buildLinuxTrayUnit(config);
  const changed = !existsSync(unitPath) || readFileSync(unitPath, "utf8") !== unit;
  mkdirSync(dirname(unitPath), { recursive: true });
  if (changed) writeFileSync(unitPath, unit, { mode: 0o644 });
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", LINUX_TRAY_SERVICE_NAME]);
  return startLinuxTrayService({ env, replace: changed, run });
}

export function uninstallLinuxTrayService({ unitPath, run = runSystemCommand }) {
  if (!existsSync(unitPath) || !readFileSync(unitPath, "utf8").startsWith(MANAGED_MARKER)) return;
  run("systemctl", ["--user", "disable", "--now", LINUX_TRAY_SERVICE_NAME]);
  rmSync(unitPath);
}

/** Registration belongs to the native helper, not the CLI's PID. A healthy service is insufficient. */
export function registeredTrayPids(run = runSystemCommand) {
  const response = JSON.parse(
    run("busctl", [
      "--user",
      "--json=short",
      "get-property",
      "org.kde.StatusNotifierWatcher",
      "/StatusNotifierWatcher",
      "org.kde.StatusNotifierWatcher",
      "RegisteredStatusNotifierItems",
    ])
  );
  return response.data.flatMap((item) => {
    try {
      const name = item.split("@")[0];
      const result = JSON.parse(
        run("busctl", [
          "--user",
          "--json=short",
          "call",
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "GetConnectionUnixProcessID",
          "s",
          name,
        ])
      );
      return result.data;
    } catch {
      return []; // An unrelated indicator may disappear during the snapshot.
    }
  });
}

export async function waitForTrayRegistration(
  pid,
  { timeoutMs = 30_000, run = runSystemCommand, signal } = {}
) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    try {
      if (registeredTrayPids(run).includes(pid)) return;
    } catch {
      // AppIndicator support can become ready after the graphical session target.
    }
    await delay(250, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error("RedRouter tray did not register with the desktop StatusNotifierWatcher");
}

export function linuxTrayServiceStatus({ unitPath, run = runSystemCommand }) {
  let state = "inactive";
  try {
    state = run("systemctl", ["--user", "is-active", LINUX_TRAY_SERVICE_NAME]);
  } catch {
    // Inactive or unavailable user manager.
  }
  let registered = false;
  try {
    const pid = Number(
      run("systemctl", ["--user", "show", LINUX_TRAY_SERVICE_NAME, "--property=MainPID", "--value"])
    );
    if (pid > 0) {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .map(Number);
      registered = registeredTrayPids(run).some((helper) => children.includes(helper));
    }
  } catch {
    // Missing /proc or watcher cannot prove desktop registration.
  }
  return { installed: existsSync(unitPath), state, registered, unit: LINUX_TRAY_SERVICE_NAME };
}
