import { spawn } from "node:child_process";

/** Whether a graphical session is there to show an icon in. */
export function hasGraphicalSession(env = process.env, platform = process.platform) {
  if (platform === "linux") return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return platform === "darwin" || platform === "win32";
}

/**
 * Starts `red-router tray attach` as its own detached process, so the icon outlives this one. With
 * `replace` an icon of another version (or an older run of this one) is taken over.
 */
export function spawnAttachedTray({
  cliPath,
  port,
  replace = false,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const args = [cliPath, "tray", "attach", "--port", String(port)];
  if (replace) args.push("--replace");
  const child = spawnImpl(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...env, OMNIROUTE_CLI_SKIP_REPO_ENV: env.OMNIROUTE_CLI_SKIP_REPO_ENV ?? "" },
  });
  child.unref?.();
  return child.pid ?? null;
}

/**
 * Whether a foreground `serve` should also put the app in the tray without being asked: a person
 * at a terminal on a desktop. Never for a service, CI, a pipe, a tray-owning worker or when opted
 * out (`--no-tray`, RED_ROUTER_TRAY=0).
 */
export function shouldAutoAttachTray({
  opts = {},
  env = process.env,
  stdoutIsTTY = Boolean(process.stdout?.isTTY),
  stdinIsTTY = Boolean(process.stdin?.isTTY),
  platform = process.platform,
} = {}) {
  if (opts.tray !== undefined) return false; // --tray owns its own flow, --no-tray opts out
  if (opts.trayWorker === true || opts.daemon === true || opts.log === true) return false;
  if (opts.recovery === false) return false;
  if (String(env.RED_ROUTER_TRAY ?? "").trim() === "0") return false;
  if (env.CI || env.INVOCATION_ID || env.JOURNAL_STREAM) return false;
  if (!stdoutIsTTY || !stdinIsTTY) return false;
  return hasGraphicalSession(env, platform);
}
