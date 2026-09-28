#!/usr/bin/env node
import { spawn } from "node:child_process";
import { suiteFiles, root } from "./redrouter-suites.mjs";

const kind = process.argv[2] || "native";
const files = suiteFiles(kind);
if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
} else {
  const args =
    kind === "native"
      ? [
          "--import",
          "tsx/esm",
          "--import",
          "./open-sse/utils/setupPolyfill.ts",
          "--import",
          "./tests/_setup/isolateDataDir.ts",
          "--test",
          "--test-force-exit",
          "--test-concurrency=2",
          ...files,
        ]
      : kind === "ui"
        ? ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.redrouter.config.ts"]
        : [
            "scripts/dev/run-playwright-tests.mjs",
            "test",
            "--config",
            "playwright.redrouter.config.ts",
          ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DISABLE_SQLITE_AUTO_BACKUP: "true", OMNIROUTE_SKIP_SYSTEM_TRUST: "1" },
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
