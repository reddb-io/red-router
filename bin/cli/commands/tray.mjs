import { t } from "../i18n.mjs";
import { DEFAULT_PORT } from "../product.mjs";

export async function attachTray({ port = DEFAULT_PORT } = {}) {
  const { initTray, killTray } = await import("../tray/index.mjs");
  const { default: open } = await import("open");
  let finish;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    killTray();
    finish();
  };
  const tray = await initTray({
    port,
    trayOnly: true,
    onQuit: stop,
    onOpenDashboard: () => open(`http://127.0.0.1:${port}/dashboard`),
    onShowLogs: () => open(`http://127.0.0.1:${port}/observe/logs`),
  });
  if (!tray) throw new Error("RedRouter tray is unavailable in this graphical session");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    killTray();
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
    .action(async ({ port }) => {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error("Port must be an integer from 1 to 65535");
      }
      await attachTray({ port: value });
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
