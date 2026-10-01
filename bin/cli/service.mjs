import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isLoopbackUrl } from "./api.mjs";
import { getCliToken, CLI_TOKEN_HEADER } from "./utils/cliToken.mjs";

import { resolveDataDir } from "./data-dir.mjs";
import { DEFAULT_HOST, DEFAULT_PORT } from "./product.mjs";
import { hasGraphicalSession, spawnAttachedTray } from "./tray/attachedTray.mjs";
import {
  installLinuxTrayService,
  linuxTrayServiceStatus,
  uninstallLinuxTrayService,
} from "./tray/linuxService.mjs";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "omniroute.mjs");

/**
 * Puts the tray of THIS version on screen right away, replacing one left over from an older version.
 * The service install runs on every upgrade; without this the icon only refreshed at the next login.
 */
function refreshTray(port, spawnTray, env = process.env) {
  if (env.RED_ROUTER_TRAY === "0" || !hasGraphicalSession(env)) return null;
  try {
    return spawnTray({ cliPath: CLI_PATH, port, replace: true, env });
  } catch {
    return null;
  }
}

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
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function servicePaths(home = process.env.HOME || homedir()) {
  return {
    linux: join(home, ".config", "systemd", "user", LINUX_SERVICE_NAME),
    linuxTray: join(home, ".config", "autostart", "red-router.desktop"),
    linuxTrayUnit: join(home, ".config", "systemd", "user", "red-router-tray.service"),
    darwin: join(home, "Library", "LaunchAgents", `${DARWIN_SERVICE_LABEL}.plist`),
  };
}

function desktopQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildTrayDesktopEntry({ misePath, port = DEFAULT_PORT } = {}) {
  const executable = misePath ? desktopQuote(misePath) : "/usr/bin/env";
  const command = misePath
    ? `${executable} exec red-router -- red-router tray start --port ${port}`
    : `${executable} red-router tray start --port ${port}`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=RedRouter Tray",
    "Comment=Attach the RedRouter tray to the existing local service",
    `Exec=${command}`,
    "Terminal=false",
    "Hidden=false",
    "X-GNOME-Autostart-enabled=true",
    "X-RedRouter-Managed=service-tray",
    "",
  ].join("\n");
}

export function isRouterDesktopEntry(content) {
  return (
    /\bX-RedRouter-Managed=service-tray\b/.test(content) ||
    (/^Name=RedRouter\s*$/m.test(content) && /^Exec=.*(?:red-router|omniroute)/m.test(content))
  );
}

function installLinuxTrayDesktop(paths, port) {
  if (existsSync(paths.linuxTray) && !isRouterDesktopEntry(readFileSync(paths.linuxTray, "utf8"))) {
    return;
  }
  let misePath;
  try {
    misePath = execFileSync("which", ["mise"], { encoding: "utf8" }).trim();
  } catch {
    // A conventional npm installation can still use a PATH-resolved red-router.
  }
  mkdirSync(dirname(paths.linuxTray), { recursive: true });
  writeFileSync(paths.linuxTray, buildTrayDesktopEntry({ misePath, port }), { mode: 0o644 });
}

export function startManagedTray({ port = DEFAULT_PORT } = {}) {
  const paths = servicePaths();
  return installLinuxTrayService({
    unitPath: paths.linuxTrayUnit,
    nodePath: resolveServiceNodePath(),
    cliPath: resolveCliPath(),
    dataDir: resolveDataDir(),
    port,
  });
}

export function resolveCliPath() {
  return fileURLToPath(new URL("../omniroute.mjs", import.meta.url));
}

export function resolveServiceNodePath(nodePath = process.execPath) {
  const nodeInstallRoot = dirname(dirname(dirname(nodePath)));
  if (basename(nodeInstallRoot) !== "node") return nodePath;
  const stablePath = join(nodeInstallRoot, "latest", "bin", "node");
  return existsSync(stablePath) ? stablePath : nodePath;
}

export function buildServiceArgs({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  return ["serve", "--port", String(port), "--host", host, "--no-open"];
}

export function buildSystemdUnit({
  nodePath = resolveServiceNodePath(),
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
  nodePath = resolveServiceNodePath(),
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
      timeout: command === "systemctl" ? 310_000 : 15_000,
    });
  } catch (error) {
    if (ignoreFailure) return "";
    throw error;
  }
}

export async function installService({
  port,
  host,
  spawnTray = spawnAttachedTray,
  paths = servicePaths(),
  platform = process.platform,
  runCommand = run,
  installTray = installLinuxTrayService,
  trayStatus = linuxTrayServiceStatus,
  probe = probeRunningVersion,
  desktopInstaller = installLinuxTrayDesktop,
  env = process.env,
} = {}) {
  const saved = readServiceConfiguration(paths.linux);
  port ??= saved?.port ?? DEFAULT_PORT;
  host ??= saved?.host ?? DEFAULT_HOST;
  if (platform === "linux") {
    let wasActive = false;
    try {
      wasActive =
        runCommand("systemctl", ["--user", "is-active", LINUX_SERVICE_NAME]).trim() === "active";
    } catch {
      // A fresh install has no active unit.
    }
    mkdirSync(dirname(paths.linux), { recursive: true });
    writeFileSync(paths.linux, buildSystemdUnit({ port, host }), { mode: 0o644 });
    runCommand("systemctl", ["--user", "daemon-reload"]);
    runCommand("systemctl", ["--user", "enable", LINUX_SERVICE_NAME]);
    runCommand("systemctl", ["--user", wasActive ? "restart" : "start", LINUX_SERVICE_NAME]);
    const version = await probe({ port });
    let tray;
    try {
      tray = installTray({
        unitPath: paths.linuxTrayUnit,
        nodePath: resolveServiceNodePath(),
        cliPath: resolveCliPath(),
        dataDir: resolveDataDir(),
        port,
        env,
        version: installedServiceVersion(),
      });
      if (tray.state === "starting") {
        const deadline = Date.now() + 5000;
        do {
          tray = { ...tray, ...trayStatus({ unitPath: paths.linuxTrayUnit }) };
          if (tray.registered || tray.state === "failed") break;
          await delay(250);
        } while (Date.now() < deadline);
        tray.ready = tray.registered === true;
        if (!tray.ready)
          tray.message = "Desktop registration is not confirmed; run red-router doctor.";
      }
      if (env.RED_ROUTER_TRAY !== "0") desktopInstaller(paths, port);
      else if (
        existsSync(paths.linuxTray) &&
        isRouterDesktopEntry(readFileSync(paths.linuxTray, "utf8"))
      ) {
        rmSync(paths.linuxTray);
      }
    } catch {
      tray = {
        state: "failed",
        message: "Inspect journalctl --user -u red-router-tray.service for tray diagnostics.",
      };
      process.stderr.write(`RedRouter tray setup failed. ${tray.message}\n`);
    }
    return {
      ok: version.matches && tray.state !== "failed",
      serverReady: version.matches,
      kind: "systemd --user",
      path: paths.linux,
      port,
      host,
      action: wasActive ? "restarted" : "started",
      version,
      tray,
    };
  }
  if (platform === "darwin") {
    mkdirSync(dirname(paths.darwin), { recursive: true });
    writeFileSync(paths.darwin, buildLaunchdPlist({ port, host }), { mode: 0o644 });
    run("launchctl", ["unload", paths.darwin], { ignoreFailure: true });
    run("launchctl", ["load", "-w", paths.darwin]);
    refreshTray(port, spawnTray);
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
    uninstallLinuxTrayService({ unitPath: paths.linuxTrayUnit });
    run("systemctl", ["--user", "disable", "--now", LINUX_SERVICE_NAME], {
      ignoreFailure: true,
    });
    rmSync(paths.linux, { force: true });
    if (
      existsSync(paths.linuxTray) &&
      /\bX-RedRouter-Managed=service-tray\b/.test(readFileSync(paths.linuxTray, "utf8"))
    ) {
      rmSync(paths.linuxTray, { force: true });
    }
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

export function serviceStatus({
  paths = servicePaths(),
  platform = process.platform,
  runCommand = run,
  trayStatus = linuxTrayServiceStatus,
} = {}) {
  if (platform === "linux") {
    let state = "inactive";
    try {
      state = runCommand("systemctl", ["--user", "is-active", LINUX_SERVICE_NAME]).trim();
    } catch (error) {
      if (error?.status !== 3) state = "unknown";
    }
    return {
      ok: true,
      kind: "systemd --user",
      installed: existsSync(paths.linux),
      state,
      path: paths.linux,
      port: readServiceConfiguration(paths.linux)?.port ?? DEFAULT_PORT,
      tray: trayStatus({ unitPath: paths.linuxTrayUnit }),
    };
  }
  if (platform === "darwin") {
    const output = runCommand("launchctl", ["list"], { ignoreFailure: true });
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

/** Reads installed metadata without starting the CLI/tray. */
export function installedServiceVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return null;
  }
}

/** The local machine credential must never follow redirects or reach a remote context. */
export async function probeRunningVersion({
  port = DEFAULT_PORT,
  url = `http://127.0.0.1:${port}/api/monitoring/health`,
  expectedVersion = installedServiceVersion(),
  fetchImpl = fetch,
  tokenProvider = getCliToken,
  timeoutMs = 10_000,
} = {}) {
  const result = {
    installedVersion: expectedVersion,
    runningVersion: null,
    matches: false,
    pid: null,
  };
  let target;
  try {
    target = new URL(url);
  } catch {
    return { ...result, reason: "invalid-url" };
  }
  if (
    !isLoopbackUrl(target) ||
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  ) {
    return { ...result, reason: "not-local" };
  }
  const token = await tokenProvider();
  if (!token) return { ...result, reason: "authentication-unavailable" };
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetchImpl(target.toString(), {
        headers: { [CLI_TOKEN_HEADER]: token },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
      });
      if (response.ok) {
        const body = await response.json();
        result.runningVersion = typeof body.version === "string" ? body.version : null;
        result.pid = Number.isInteger(body.system?.pid) ? body.system.pid : null;
        result.matches = !!expectedVersion && result.runningVersion === expectedVersion;
        if (result.matches) return result;
      } else if (response.status === 401 || response.status === 403) {
        return { ...result, reason: "authentication-rejected" };
      }
    } catch {
      // Readiness may lag behind the manager reporting active.
    }
    if (Date.now() < deadline) await delay(250);
  } while (Date.now() < deadline);
  return { ...result, reason: result.runningVersion ? "version-mismatch" : "version-unavailable" };
}

/** Only use our explicit environment lines; never evaluate a unit's shell/ExecStart. */
export function readServiceConfiguration(unitPath = servicePaths().linux) {
  try {
    const text = readFileSync(unitPath, "utf8");
    if (!text.includes("Description=RedRouter AI routing gateway")) return null;
    const port = Number(/^Environment="RED_ROUTER_PORT=(\d+)"$/m.exec(text)?.[1]);
    const host = /^Environment="RED_ROUTER_SERVER_HOST=([a-zA-Z0-9.:[\]-]+)"$/m.exec(text)?.[1];
    return port > 0 && port <= 65535 && host ? { port, host } : null;
  } catch {
    return null;
  }
}
