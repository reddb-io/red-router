import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { isPidRunning } from "../utils/pid.mjs";

function runningPids(dataDir, running) {
  return ["server", "supervisor"].flatMap((service) => {
    try {
      const pid = Number(readFileSync(join(dataDir, service, ".pid"), "utf8").trim());
      return Number.isInteger(pid) && pid > 0 && running(pid) ? [pid] : [];
    } catch {
      return [];
    }
  });
}

const runSystemd = (args) =>
  execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Stop only the managed service owning these PID files, never an unrelated instance. */
export async function withRestoreMaintenance(dataDir, operation, dependencies = {}) {
  const running = dependencies.isPidRunning ?? isPidRunning;
  const run = dependencies.runSystemd ?? runSystemd;
  const pids = runningPids(dataDir, running);
  if (!pids.length) return operation();
  let managedPid = 0;
  if ((dependencies.platform ?? process.platform) === "linux") {
    try {
      managedPid = Number(run(["show", "red-router.service", "--property=MainPID", "--value"]));
    } catch {
      // Without proof of ownership, fail before touching any files.
    }
  }
  if (!pids.includes(managedPid)) {
    throw new Error(
      "Stop the RedRouter server and its supervisor before restoring this data directory"
    );
  }
  run(["stop", "red-router.service"]);
  try {
    const deadline = Date.now() + 30_000;
    while (runningPids(dataDir, running).length) {
      if (Date.now() >= deadline) throw new Error("RedRouter did not stop; restore was cancelled");
      await delay(100);
    }
    return await operation();
  } finally {
    run(["start", "red-router.service"]);
  }
}
