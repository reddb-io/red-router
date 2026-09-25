#!/usr/bin/env node

// Headless service management for RedRouter. Installs a per-user service
// definition (systemd user unit on Linux, launchd agent on macOS) that keeps
// the launcher (and therefore the server) running in the background across
// reboots. Windows has no built-in per-user service manager here; the CLI
// falls back to `--tray` background mode guidance.
//
// Network exposure is opt-in: services follow the saved network setting
// (`red-router network local|network`, or the dashboard) and bind 127.0.0.1 when
// none is saved. `--host 0.0.0.0` (or `--expose`) pins the address instead.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveHost } = require("./src/cli/network");

const SERVICE_ID = "red-router";
const LINUX_UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const LINUX_UNIT_PATH = path.join(LINUX_UNIT_DIR, `${SERVICE_ID}.service`);
const DARWIN_PLIST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const DARWIN_PLIST_PATH = path.join(DARWIN_PLIST_DIR, `io.reddb.${SERVICE_ID}.plist`);
const DEFAULT_SERVICE_HOST = "127.0.0.1";

function resolvePlatform() {
  return process.platform;
}

// An explicit host is pinned in the definition; otherwise the service follows the
// saved network setting (`red-router network`), local-only when none is saved.
function launcherArgs({ port, host }) {
  const bind = host ? ["-H", host] : ["--default-host", DEFAULT_SERVICE_HOST];
  return ["-p", String(port), ...bind, "--skip-update", "-n"];
}

function buildSystemdUnit({ nodePath, cliPath, port, host }) {
  return [
    "[Unit]",
    "Description=RedRouter - local AI routing gateway",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${JSON.stringify(nodePath)} ${JSON.stringify(cliPath)} ${launcherArgs({ port, host }).map((a) => JSON.stringify(a)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=3",
    "Environment=NODE_ENV=production",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function buildLaunchdPlist({ nodePath, cliPath, port, host }) {
  const args = [nodePath, cliPath, ...launcherArgs({ port, host })];
  const xmlArgs = args.map((a) => `      <string>${a.replace(/&/g, "&amp;")}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.reddb.${SERVICE_ID}</string>
    <key>ProgramArguments</key>
    <array>
${xmlArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

function resolveNodeAndCli() {
  return { nodePath: process.execPath, cliPath: path.resolve(__dirname, "cli.js") };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function installService({ port = 25050, host } = {}) {
  // What the service binds now; without a pinned host it follows the saved setting.
  const resolvedHost = resolveHost({ flagHost: host, defaultHost: DEFAULT_SERVICE_HOST }).host;
  const pinned = Boolean(host);
  const { nodePath, cliPath } = resolveNodeAndCli();
  const platform = resolvePlatform();

  if (platform === "linux") {
    fs.mkdirSync(LINUX_UNIT_DIR, { recursive: true });
    fs.writeFileSync(LINUX_UNIT_PATH, buildSystemdUnit({ nodePath, cliPath, port, host }));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${SERVICE_ID}.service`]);
    return { ok: true, host: resolvedHost, pinned, port, kind: "systemd --user", path: LINUX_UNIT_PATH };
  }

  if (platform === "darwin") {
    fs.mkdirSync(DARWIN_PLIST_DIR, { recursive: true });
    fs.writeFileSync(DARWIN_PLIST_PATH, buildLaunchdPlist({ nodePath, cliPath, port, host }));
    try {
      run("launchctl", ["unload", DARWIN_PLIST_PATH]);
    } catch {}
    run("launchctl", ["load", DARWIN_PLIST_PATH]);
    return { ok: true, host: resolvedHost, pinned, port, kind: "launchd", path: DARWIN_PLIST_PATH };
  }

  return {
    ok: false,
    host: resolvedHost,
    port,
    kind: "unsupported",
    message:
      "Windows não tem service manager per-user aqui. Use o modo background com tray: `red-router -t` " +
      "(ou agende `red-router -p PORT -H HOST --skip-update -n` no Agendador de Tarefas).",
  };
}

function uninstallService() {
  const platform = resolvePlatform();

  if (platform === "linux") {
    try {
      run("systemctl", ["--user", "disable", "--now", `${SERVICE_ID}.service`]);
    } catch {}
    fs.rmSync(LINUX_UNIT_PATH, { force: true });
    try {
      run("systemctl", ["--user", "daemon-reload"]);
    } catch {}
    return { ok: true, kind: "systemd --user" };
  }

  if (platform === "darwin") {
    try {
      run("launchctl", ["unload", DARWIN_PLIST_PATH]);
    } catch {}
    fs.rmSync(DARWIN_PLIST_PATH, { force: true });
    return { ok: true, kind: "launchd" };
  }

  return { ok: false, kind: "unsupported", message: "Sem service instalado no Windows; feche o tray para parar." };
}

function serviceStatus() {
  const platform = resolvePlatform();

  if (platform === "linux") {
    try {
      const state = run("systemctl", ["--user", "is-active", `${SERVICE_ID}.service`]).trim();
      return { ok: true, kind: "systemd --user", state };
    } catch (error) {
      const state = error && error.status === 3 ? "inactive" : "unknown";
      return { ok: true, kind: "systemd --user", state };
    }
  }

  if (platform === "darwin") {
    try {
      const out = run("launchctl", ["list"]).split("\n").some((l) => l.includes(`io.reddb.${SERVICE_ID}`));
      return { ok: true, kind: "launchd", state: out ? "running" : "not loaded" };
    } catch {
      return { ok: true, kind: "launchd", state: "unknown" };
    }
  }

  return { ok: false, kind: "unsupported", message: "Use o Task Manager no Windows (modo tray)." };
}

module.exports = {
  SERVICE_ID,
  DEFAULT_SERVICE_HOST,
  buildLaunchdPlist,
  buildSystemdUnit,
  installService,
  launcherArgs,
  resolvePlatform,
  serviceStatus,
  uninstallService,
};
