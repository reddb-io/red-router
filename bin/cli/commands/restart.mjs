import { t } from "../i18n.mjs";
import { runStopCommand } from "./stop.mjs";
import { sleep } from "../utils/pid.mjs";
import { restartManagedService } from "../service.mjs";

export function registerRestart(program) {
  program
    .command("restart")
    .description(t("restart.description"))
    // No Commander default: runServe() falls back to PORT, then 25050 (#7049).
    .option("--port <port>", t("serve.port"))
    .action(async (opts) => {
      const exitCode = await runRestartCommand(opts);
      if (exitCode !== 0) process.exit(exitCode);
    });
}

export async function runRestartCommand(opts = {}, deps = {}) {
  console.log(t("restart.restarting"));

  const managed = await (deps.restartService || restartManagedService)({ port: opts.port });
  if (managed.handled) {
    if (!managed.ok) {
      console.error(
        "RedRouter service restart could not be verified. Inspect journalctl --user -u red-router.service."
      );
    }
    return managed.ok ? 0 : 1;
  }

  const stopCode = await (deps.stop || runStopCommand)(opts);
  if (stopCode !== 0) return stopCode;
  await (deps.sleep || sleep)(1000);

  const runServe = deps.serve || (await import("./serve.mjs")).runServe;
  await runServe(opts);
  return 0;
}
