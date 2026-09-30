import { t } from "../i18n.mjs";
import { DEFAULT_PORT } from "../product.mjs";
import { startManagedTray } from "../service.mjs";
import { runTrayLifecycle } from "../tray/lifecycle.mjs";
import {
  registeredTrayPids,
  runSystemCommand,
  waitForTrayRegistration,
} from "../tray/linuxService.mjs";

export async function attachTray({ port = DEFAULT_PORT, replace = false, managed = false } = {}) {
  const { claimTrayLock, releaseTrayLock } = await import("../tray/singleInstance.mjs");
  // Nothing to show an icon in (started by a service or a session without a display): fail BEFORE
  // taking the lock, or the running tray would be stopped for a replacement that cannot appear.
  const { isTraySupported } = await import("../tray/index.mjs");
  if (!isTraySupported()) {
    throw new Error("RedRouter tray is unavailable in this session (no graphical display)");
  }
  const lock = claimTrayLock({ port, replace });
  if (!lock.claimed) {
    process.stderr.write(`RedRouter tray is already running (pid ${lock.pid}).\n`);
    return;
  }
  const { initTray, killTray } = await import("../tray/index.mjs");
  const { default: open } = await import("open");
  await runTrayLifecycle({
    initialize: () =>
      initTray({
        port,
        trayOnly: true,
        onQuit: () => process.emit("SIGTERM"),
        onOpenDashboard: () => open(`http://127.0.0.1:${port}/usage`),
        onShowLogs: () => open(`http://127.0.0.1:${port}/observe/logs`),
      }),
    destroy: killTray,
    release: releaseTrayLock,
    onReady: managed
      ? async (tray, signal) => {
          const child = tray._process ?? tray.process;
          await waitForTrayRegistration(child?.pid, { signal });
          runSystemCommand("systemd-notify", [
            "--ready",
            "--status=RedRouter tray registered with the desktop",
          ]);
        }
      : undefined,
    healthCheck: managed
      ? (tray) => registeredTrayPids().includes((tray._process ?? tray.process)?.pid)
      : undefined,
  });
}

export function registerTray(program) {
  const cmd = program
    .command("tray")
    .description(t("tray.description") || "Control the system tray icon");

  const attach = cmd
    .command("attach")
    .description(
      "Show a tray icon for the existing RedRouter service without starting another server"
    )
    .option("-p, --port <port>", "Existing RedRouter service port", String(DEFAULT_PORT))
    .option("--replace", "Take over a tray that is already running (used after an upgrade)")
    .action(async ({ port, replace, managed }) => {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("Port must be an integer from 1 to 65535");
      }
      await attachTray({ port: value, replace: replace === true, managed: managed === true });
    });
  attach.addOption(attach.createOption("--managed").hideHelp());

  cmd
    .command("start")
    .description("Start the supervised Linux tray for the existing local service")
    .option("-p, --port <port>", "Existing RedRouter service port", String(DEFAULT_PORT))
    .action(({ port }) => {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535)
        throw new Error("Port must be an integer from 1 to 65535");
      if (process.platform !== "linux")
        throw new Error("Use red-router tray attach on this platform");
      const result = startManagedTray({ port: value });
      process.stderr.write(`RedRouter tray: ${result.state}.\n`);
    });

  cmd
    .command("show")
    .description(t("tray.show") || "Show how to attach the tray to a running service")
    .action(() => {
      if (process.platform === "linux") {
        const result = startManagedTray();
        process.stderr.write(`RedRouter tray: ${result.state}.\n`);
        return;
      }
      process.stderr.write(
        "Run `red-router tray attach` to show the tray for the running service.\n"
      );
    });

  cmd
    .command("hide")
    .description(t("tray.hide") || "Hide the tray icon")
    .action(() => {
      if (process.platform === "linux") {
        runSystemCommand("systemctl", ["--user", "stop", "red-router-tray.service"]);
        process.stderr.write("RedRouter tray stopped; the server remains running.\n");
        return;
      }
      process.stderr.write(
        "Send SIGUSR1 to the serve process to toggle the tray, or restart without --tray.\n"
      );
    });

  cmd
    .command("quit")
    .description(t("tray.quit") || "Stop the RedRouter service")
    .action(() => {
      process.stderr.write("Use `red-router service uninstall` to stop the managed service.\n");
    });
}
