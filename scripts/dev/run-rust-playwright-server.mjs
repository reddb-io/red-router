#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const executable = process.platform === "win32" ? "red-routerd.exe" : "red-routerd";
const binary = [
  join(root, "rust-runtime", `${process.platform}-${process.arch}`, executable),
  join(root, "rust", "red-routerd", "target", "release", executable),
].find(existsSync);
const spa = [join(root, "rust-runtime", "dashboard"), join(root, ".build", "rust-dashboard")].find(
  (path) => existsSync(join(path, "index.html"))
);

if (!binary) throw new Error("The packaged red-routerd binary is missing; run build:release first");
if (!spa) throw new Error("The packaged Rust dashboard is missing; run build:release first");

const dataDir = mkdtempSync(join(tmpdir(), "red-router-playwright-"));
const port = process.env.DASHBOARD_PORT || process.env.PORT || "25050";
const adminKey = process.env.RED_ROUTER_ADMIN_KEY || "red-router-e2e-admin-key-00000001";
const child = spawn(binary, [], {
  cwd: dataDir,
  stdio: "inherit",
  env: {
    ...process.env,
    RED_ROUTER_LISTEN: `127.0.0.1:${port}`,
    RED_ROUTER_SPA_DIR: spa,
    RED_ROUTER_DB_BACKEND: "sqlite",
    RED_ROUTER_ADMIN_KEY: adminKey,
    RED_ROUTER_CLIENT_KEY: process.env.RED_ROUTER_CLIENT_KEY || "red-router-e2e-client-key-0000001",
    STORAGE_ENCRYPTION_KEY:
      process.env.STORAGE_ENCRYPTION_KEY || "red-router-e2e-storage-key-0000001",
  },
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(signal));
}

child.once("error", (error) => {
  console.error(error.message);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
child.once("exit", (code, signal) => {
  rmSync(dataDir, { recursive: true, force: true });
  if (signal && !stopping) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
