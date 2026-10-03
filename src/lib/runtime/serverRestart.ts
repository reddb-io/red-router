import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readNetworkAccessStatus } from "./networkAccess";

const run = promisify(execFile);

type Options = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedStatus?: () => Promise<{ managed: boolean }>;
  execute?: (command: string, args: string[]) => Promise<{ stdout?: string }>;
  schedule?: (action: () => void) => void;
  terminate?: () => void;
};

/** Queue a restart outside our cgroup, so stopping this service cannot kill its restarter. */
export async function requestServerRestart(options: Options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const execute =
    options.execute ||
    ((command, args) =>
      run(command, args, {
        timeout: 5000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }));
  if (platform === "linux" && (env.INVOCATION_ID || env.NOTIFY_SOCKET)) {
    const status = await (options.managedStatus || readNetworkAccessStatus)();
    if (!status.managed || !env.INVOCATION_ID) {
      throw new Error("Restart this custom service through its service manager.");
    }
    const { stdout } = await execute("systemctl", [
      "--user",
      "show",
      "red-router.service",
      "--property=InvocationID",
      "--value",
    ]);
    if (stdout?.trim() !== env.INVOCATION_ID) {
      throw new Error("The running Router does not belong to red-router.service.");
    }
    // A transient timer admits the job before responding, then restarts the entire
    // unit after the HTTP response. Its process survives our cgroup's shutdown.
    await execute("systemd-run", [
      "--user",
      "--collect",
      "--quiet",
      `--unit=red-router-restart-${randomUUID()}`,
      "--on-active=1s",
      "--timer-property=AccuracySec=100ms",
      "--",
      "systemctl",
      "--user",
      "restart",
      "red-router.service",
    ]);
    console.info("[Lifecycle] Dashboard restart accepted by the service manager.");
    return "service";
  }
  console.info("[Lifecycle] Dashboard restart requested for a standalone server.");
  const terminate = options.terminate || (() => process.kill(process.pid, "SIGTERM"));
  (
    options.schedule ||
    ((action) => {
      setTimeout(action, 500);
    })
  )(terminate);
  return "standalone";
}
