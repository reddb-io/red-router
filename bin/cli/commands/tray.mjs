import { t } from "../i18n.mjs";
import { DEFAULT_PORT } from "../product.mjs";

export async function attachTray({ port = DEFAULT_PORT, replace = false } = {}) {
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
  let finish;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    killTray();
    releaseTrayLock();
    finish();
  };
  const tray = await initTray({
    port,
    trayOnly: true,
    onQuit: stop,
    onOpenDashboard: () => open(`http://127.0.0.1:${port}/dashboard`),
    onShowLogs: () => open(`http://127.0.0.1:${port}/observe/logs`),
  });
  if (!tray) {
    releaseTrayLock();
    throw new Error("RedRouter tray is unavailable in this graphical session");
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    killTray();
    releaseTrayLock();
  }
}

export function registerTray(program) {
  const cmd = program
    .command("tray")
    .description(t("tray.description") || "Control the system tray icon");

  cmd
    .command("attach")
    .description(
      "Show a tray icon for the existing RedRouter service without starting another server"
    )
    .option("-p, --port <port>", "Existing RedRouter service port", String(DEFAULT_PORT))
    .option("--replace", "Take over a tray that is already running (used after an upgrade)")
    .action(async ({ port, replace }) => {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("Port must be an integer from 1 to 65535");
      }
      await attachTray({ port: value, replace: replace === true });
    });

  cmd
    .command("show")
    .description(t("tray.show") || "Show how to attach the tray to a running service")
    .action(() => {
      process.stderr.write(
        "Run `red-router tray attach` to show the tray for the running service.\n"
      );
    });

  cmd
    .command("hide")
    .description(t("tray.hide") || "Hide the tray icon")
    .action(() => {
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
