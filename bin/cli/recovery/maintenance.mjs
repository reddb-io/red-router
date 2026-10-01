import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
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

/** A dev/Next process may hold SQLite without the CLI's PID files. */
function openDatabasePids(dataDir) {
  let database;
  try {
    database = realpathSync(join(dataDir, "storage.sqlite"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = new Set([
    database,
    ...["-wal", "-shm", "-journal"].map((suffix) => database + suffix),
  ]);
  const owners = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const directory = join("/proc", entry, "fd");
    try {
      if (
        readdirSync(directory).some((fd) => {
          try {
            return files.has(readlinkSync(join(directory, fd)).replace(/ \(deleted\)$/, ""));
          } catch {
            return false;
          }
        })
      )
        owners.push(Number(entry));
    } catch (error) {
      // Other users cannot read the private data directory. Processes can exit while scanning.
      if (!["EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error;
    }
  }
  return owners;
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
  const platform = dependencies.platform ?? process.platform;
  const findOpenPids =
    platform === "linux" ? (dependencies.findOpenDatabasePids ?? openDatabasePids) : () => [];
  const activePids = () => [
    ...new Set([...runningPids(dataDir, running), ...findOpenPids(dataDir)]),
  ];
  const pids = activePids();
  if (!pids.length) return operation();
  let managedPid = 0;
  if (platform === "linux") {
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
    while (activePids().length) {
      if (Date.now() >= deadline) throw new Error("RedRouter did not stop; restore was cancelled");
      await delay(100);
    }
    return await operation();
  } finally {
    run(["start", "red-router.service"]);
  }
}
