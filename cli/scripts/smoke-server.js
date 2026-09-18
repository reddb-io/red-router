#!/usr/bin/env node

// Boot smoke test for the packaged CLI app. Fails the build if the bundled
// server cannot start and answer HTTP requests (catches pnpm standalone
// trace gaps like MODULE_NOT_FOUND @swc/helpers / @next/env before publish).
// Usage: node scripts/smoke-server.js [port]

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const cliDir = path.resolve(__dirname, "..");
const serverEntry = path.join(cliDir, "app", "server.js");
const PORT = Number(process.argv[2]) || 25777;
const BOOT_TIMEOUT_MS = 45000;

if (!fs.existsSync(serverEntry)) {
  console.error(`❌ Smoke test: built server not found at ${serverEntry}. Run the build first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: cliDir,
  env: { ...process.env, PORT: String(PORT), HOSTNAME: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
const forward = (buf) => {
  output += buf.toString();
};
child.stdout.on("data", forward);
child.stderr.on("data", forward);

const fail = (message) => {
  console.error(`❌ Smoke test failed: ${message}`);
  if (output.trim()) console.error(output.trim().split("\n").slice(-20).join("\n"));
  child.kill("SIGKILL");
  process.exit(1);
};

const bootTimer = setTimeout(() => fail(`server did not answer within ${BOOT_TIMEOUT_MS / 1000}s`), BOOT_TIMEOUT_MS);

const probe = async (attempt) => {
  if (child.exitCode !== null) fail(`server exited with code ${child.exitCode}`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/dashboard`, { redirect: "manual" });
    clearTimeout(bootTimer);
    console.log(`✅ Smoke test passed: server answered HTTP ${res.status} on :${PORT} (attempt ${attempt})`);
    child.kill("SIGKILL");
    process.exit(0);
  } catch (error) {
    if (error && error.cause && error.cause.code === "ECONNREFUSED") {
      setTimeout(() => probe(attempt + 1), 500);
      return;
    }
    fail(`unexpected probe error: ${error && error.message}`);
  }
};

probe(1);
