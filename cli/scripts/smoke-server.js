#!/usr/bin/env node

// Boot smoke test for the packaged CLI app. Fails the release if the bundled
// server cannot start and answer HTTP requests. It packs the real tarball and
// boots it from an isolated directory (no parent node_modules) so that Node
// cannot accidentally resolve missing deps by walking up the workspace —
// catching pnpm standalone trace gaps like MODULE_NOT_FOUND
// @swc/helpers / @next/env / react before publish.
// Usage: node scripts/smoke-server.js [port]

const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const cliDir = path.resolve(__dirname, "..");
const serverEntry = path.join(cliDir, "app", "server.js");
const PORT = Number(process.argv[2]) || 25777;
const BOOT_TIMEOUT_MS = 60000;

if (!fs.existsSync(serverEntry)) {
  console.error(`❌ Smoke test: built server not found at ${serverEntry}. Run the build first.`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-smoke-"));
let stageDir = path.join(tmpDir, "pkg");
let child = null;

const cleanup = (code) => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
};

try {
  // Stage the real artifact: pack + extract so the test runs what would ship.
  const tarballName = execFileSync("npm", ["pack", "--pack-destination", tmpDir], { cwd: cliDir, encoding: "utf8" }).trim().split("\n").pop();
  const tarball = path.join(tmpDir, tarballName);
  execFileSync("tar", ["-xzf", tarball, "-C", tmpDir]);
  stageDir = path.join(tmpDir, "package");
  console.log(`📦 Smoke test on packed artifact: ${tarballName}`);
} catch (error) {
  console.error(`❌ Smoke test: failed to pack/extract (${error && error.message}); falling back to cli/app`);
  stageDir = path.join(tmpDir, "appcopy");
  fs.cpSync(path.join(cliDir, "app"), stageDir, { recursive: true });
}

child = spawn(process.execPath, [path.join(stageDir, "app", "server.js")], {
  cwd: stageDir,
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
  cleanup(1);
};

const bootTimer = setTimeout(() => fail(`server did not answer within ${BOOT_TIMEOUT_MS / 1000}s`), BOOT_TIMEOUT_MS);

const probe = async (attempt) => {
  if (child.exitCode !== null) fail(`server exited with code ${child.exitCode}`);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/dashboard`, { redirect: "manual" });
    clearTimeout(bootTimer);
    console.log(`✅ Smoke test passed: server answered HTTP ${res.status} on :${PORT} (attempt ${attempt})`);
    cleanup(0);
  } catch (error) {
    if (error && error.cause && error.cause.code === "ECONNREFUSED") {
      setTimeout(() => probe(attempt + 1), 500);
      return;
    }
    fail(`unexpected probe error: ${error && error.message}`);
  }
};

probe(1);
