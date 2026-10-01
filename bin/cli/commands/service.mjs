import { emit } from "../output.mjs";
import { DEFAULT_PORT } from "../product.mjs";
import {
  installService,
  probeRunningVersion,
  serviceStatus,
  uninstallService,
} from "../service.mjs";

function normalizeHost(options) {
  if (options.local) return "127.0.0.1";
  if (options.expose) return "0.0.0.0";
  return options.host;
}

function normalizePort(value) {
  const port = Number.parseInt(String(value), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

export function registerService(program) {
  const service = program.command("service").description("Manage the RedRouter background service");

  service
    .command("install")
    .description("Install and start the per-user RedRouter service")
    .option("-p, --port <port>", "Port to listen on (preserves installed configuration)")
    .option("-H, --host <host>", "Host to bind (preserves installed configuration)")
    .option("--local", "Bind to 127.0.0.1")
    .option("--expose", "Bind to 0.0.0.0")
    .action(async (options, command) => {
      const result = await installService({
        port: options.port === undefined ? undefined : normalizePort(options.port),
        host: normalizeHost(options),
      });
      emit(result, command.optsWithGlobals());
      if (!result.ok) process.exitCode = 1;
    });

  service
    .command("status")
    .description("Show the RedRouter service state")
    .action(async (options, command) => {
      const result = serviceStatus();
      result.version = await probeRunningVersion({ port: result.port, dataDir: result.dataDir });
      emit(result, command.optsWithGlobals());
      if (!result.ok) process.exitCode = 1;
    });

  service
    .command("uninstall")
    .description("Stop and remove the per-user RedRouter service")
    .action((options, command) => {
      const result = uninstallService();
      emit(result, command.optsWithGlobals());
      if (!result.ok) process.exitCode = 1;
    });
}
