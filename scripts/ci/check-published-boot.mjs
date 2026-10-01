import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function checkPublishedHealth(baseUrl, version, password, request = fetch) {
  const ready = await request(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (ready.status !== 200) return false;
  const login = await request(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(5000),
  });
  if (!login.ok) throw new Error(`Published package login HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("Published package did not issue a dashboard session");
  const health = await request(`${baseUrl}/api/monitoring/health`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  });
  const body = await health.json();
  if (health.status !== 200 || body.version !== version) {
    throw new Error(`Published package health/version mismatch (expected ${version})`);
  }
  return true;
}

async function main() {
  const version = process.env.VERSION;
  if (!/^0\.\d+\.\d+$/.test(version || ""))
    throw new Error("VERSION must be a stable RedRouter version");
  const dataDir = await mkdtemp(join(tmpdir(), "redrouter-published-boot-"));
  const port = 23000 + (process.pid % 4000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const password = "published-package-ci-only-password";
  const child = spawn("red-router", ["serve", "--port", String(port), "--log", "--no-open"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      INITIAL_PASSWORD: password,
      DISABLE_SQLITE_AUTO_BACKUP: "true",
      OMNIROUTE_SKIP_SYSTEM_TRUST: "1",
    },
  });
  let output = "";
  let spawnError;
  const retain = (chunk) => {
    output = (output + String(chunk)).slice(-20000);
  };
  child.stdout.on("data", retain);
  child.stderr.on("data", retain);
  child.on("error", (error) => {
    spawnError = error;
  });
  try {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Published CLI exited before readiness");
      let listening = false;
      try {
        listening =
          (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) })).status === 200;
      } catch {
        /* startup */
      }
      if (listening && (await checkPublishedHealth(baseUrl, version, password))) {
        console.log(
          `[published-boot] npm-installed RedRouter ${version} serves HTTP 200 with authenticated version verification`
        );
        return;
      }
      await delay(2000);
    }
    throw new Error("Published CLI readiness deadline exceeded");
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((accept) => child.once("exit", accept));
      process.kill(-child.pid, "SIGTERM");
      await Promise.race([stopped, delay(15000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await Promise.race([stopped, delay(5000, undefined, { ref: false })]);
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("Published CLI did not stop");
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
