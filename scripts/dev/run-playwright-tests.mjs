#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { sanitizeColorEnv } from "../build/runtime-env.mjs";

const defaultArgs = ["test", "tests/e2e/*.spec.ts"];
const forwardedArgs = process.argv.slice(2);
const args = forwardedArgs.length > 0 ? forwardedArgs : defaultArgs;
const playwrightEnv = sanitizeColorEnv(process.env);

delete playwrightEnv.NO_COLOR;
delete playwrightEnv.FORCE_COLOR;

// Resolve the same runner instance that tests import; browser integrations may
// legitimately install another version of the runtime playwright package.
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve("@playwright/test/cli"), ...args], {
  stdio: "inherit",
  env: playwrightEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
