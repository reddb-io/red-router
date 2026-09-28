import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./data-dir.mjs";
import { DEFAULT_HOST, DEFAULT_PORT } from "./product.mjs";

export const SERVICE_ID = "red-router";
export const LINUX_SERVICE_NAME = `${SERVICE_ID}.service`;
export const DARWIN_SERVICE_LABEL = `io.reddb.${SERVICE_ID}`;

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function servicePaths(home = process.env.HOME || homedir()) {
  return {
    linux: join(home, ".config", "systemd", "user", LINUX_SERVICE_NAME),
    darwin: join(home, "Library", "LaunchAgents", `${DARWIN_SERVICE_LABEL}.plist`),
  };
}

export function resolveCliPath() {
  return fileURLToPath(new URL("../omniroute.mjs", import.meta.url));
}

export function buildServiceArgs({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  return ["serve", "--port", String(port), "--host", host, "--no-open"];
}

export function buildSystemdUnit({
  nodePath = process.execPath,
  cliPath = resolveCliPath(),
  dataDir = resolveDataDir(),
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
} = {}) {
  const args = buildServiceArgs({ port, host });
  const execStart = [nodePath, cliPath, ...args].map(systemdQuote).join(" ");
  return [
    "[Unit]",
    "Description=RedRouter AI routing gateway",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=notify",
    "NotifyAccess=all",
    "WatchdogSec=180",
    "TimeoutStartSec=300",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5",
    "Environment=NODE_ENV=production",
    `Environment=${systemdQuote(`DATA_DIR=${dataDir}`)}`,
    `Environment=${systemdQuote(`RED_ROUTER_PORT=${port}`)}`,
    `Environment=${systemdQuote(`RED_ROUTER_SERVER_HOST=${host}`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function buildLaunchdPlist({
  nodePath = process.execPath,
  cliPath = resolveCliPath(),
  dataDir = resolveDataDir(),
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
} = {}) {
  const args = [nodePath, cliPath, ...buildServiceArgs({ port, host })];
  const xmlArgs = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${DARWIN_SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
${xmlArgs}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>DATA_DIR</key><string>${xmlEscape(dataDir)}</string>
    <key>RED_ROUTER_PORT</key><string>${port}</string>
    <key>RED_ROUTER_SERVER_HOST</key><string>${xmlEscape(host)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function run(command, args, { ignoreFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (ignoreFailure) return "";
    throw error;
  }
}

export function installService({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const paths = servicePaths();
  if (process.platform === "linux") {
    mkdirSync(dirname(paths.linux), { recursive: true });
    writeFileSync(paths.linux, buildSystemdUnit({ port, host }), { mode: 0o644 });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", LINUX_SERVICE_NAME]);
    return { ok: true, kind: "systemd --user", path: paths.linux, port, host };
  }
  if (process.platform === "darwin") {
    mkdirSync(dirname(paths.darwin), { recursive: true });
    writeFileSync(paths.darwin, buildLaunchdPlist({ port, host }), { mode: 0o644 });
    run("launchctl", ["unload", paths.darwin], { ignoreFailure: true });
    run("launchctl", ["load", "-w", paths.darwin]);
    return { ok: true, kind: "launchd", path: paths.darwin, port, host };
  }
  return {
    ok: false,
    kind: "unsupported",
    port,
    host,
    message: "Background service management is supported on Linux and macOS.",
  };
}

export function uninstallService() {
  const paths = servicePaths();
  if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", LINUX_SERVICE_NAME], {
      ignoreFailure: true,
    });
    rmSync(paths.linux, { force: true });
    run("systemctl", ["--user", "daemon-reload"], { ignoreFailure: true });
    return { ok: true, kind: "systemd --user" };
  }
  if (process.platform === "darwin") {
    run("launchctl", ["unload", paths.darwin], { ignoreFailure: true });
    rmSync(paths.darwin, { force: true });
    return { ok: true, kind: "launchd" };
  }
  return {
    ok: false,
    kind: "unsupported",
    message: "Background service management is supported on Linux and macOS.",
  };
}

export function serviceStatus() {
  const paths = servicePaths();
  if (process.platform === "linux") {
    let state = "inactive";
    try {
      state = run("systemctl", ["--user", "is-active", LINUX_SERVICE_NAME]).trim();
    } catch (error) {
      if (error?.status !== 3) state = "unknown";
    }
    return {
      ok: true,
      kind: "systemd --user",
      installed: existsSync(paths.linux),
      state,
      path: paths.linux,
    };
  }
  if (process.platform === "darwin") {
    const output = run("launchctl", ["list"], { ignoreFailure: true });
    return {
      ok: true,
      kind: "launchd",
      installed: existsSync(paths.darwin),
      state: output.includes(DARWIN_SERVICE_LABEL) ? "running" : "not loaded",
      path: paths.darwin,
    };
  }
  return {
    ok: false,
    kind: "unsupported",
    message: "Background service management is supported on Linux and macOS.",
  };
}
