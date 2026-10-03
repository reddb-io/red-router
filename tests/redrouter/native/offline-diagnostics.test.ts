import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendRuntimeLog,
  createRuntimeLogSink,
  createRuntimeLogFollower,
  getRuntimeLogPath,
  openLocalDiagnostics,
  readLogTail,
} from "../../../bin/cli/runtime/localLogs.mjs";
import { runLogsCommand, resolveLogSource } from "../../../bin/cli/commands/logs.mjs";

const root = mkdtempSync(join(tmpdir(), "redrouter-offline-logs-"));
after(() => rmSync(root, { recursive: true, force: true }));
const home = (name: string) => join(root, name);

test("runtime output survives stop; split pipe credentials stay redacted and files stay private", () => {
  const dataDir = home("credentials");
  const sink = createRuntimeLogSink({ dataDir, channel: "server.stderr" });
  sink.write(Buffer.from("Authorization: Bea"));
  sink.write(Buffer.from("rer secret-that-must-not-survive\nFatal startup failure\n"));
  sink.write("last partial diagnostic");
  sink.flush();
  const path = getRuntimeLogPath(dataDir);
  const text = readFileSync(path, "utf8");
  assert.match(text, /Fatal startup failure/);
  assert.match(text, /last partial diagnostic/);
  assert.doesNotMatch(text, /secret-that-must-not-survive/);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("log files rotate with bounded disk use and oversized lines cannot leak fragments", () => {
  const dataDir = home("rotation");
  const path = getRuntimeLogPath(dataDir);
  for (let i = 0; i < 40; i++)
    appendRuntimeLog(`event-${i} ${"x".repeat(80)}`, {
      dataDir,
      maxBytes: 512,
      backups: 3,
    });
  for (const file of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
    assert.ok(statSync(file).size <= 512);
  }
  assert.throws(() => statSync(`${path}.4`), /ENOENT/);
  const sink = createRuntimeLogSink({ dataDir });
  sink.write("Authorization: Bearer " + "private".repeat(2000));
  sink.write("credential-tail\nordinary next line\n");
  assert.doesNotMatch(readFileSync(path, "utf8"), /private|credential-tail/);
  assert.match(readFileSync(path, "utf8"), /ordinary next line/);
});

test("following reads repeated messages and drains the old file before reopening after rotation", () => {
  const dataDir = home("following");
  appendRuntimeLog("existing", { dataDir });
  const follower = createRuntimeLogFollower(dataDir);
  try {
    appendRuntimeLog("repeated", { dataDir });
    assert.match(follower.poll(), /repeated/);
    appendRuntimeLog("repeated", { dataDir });
    assert.match(follower.poll(), /repeated/);
    appendRuntimeLog("before rotation", { dataDir });
    appendRuntimeLog("after rotation", { dataDir, maxBytes: 80 });
    assert.match(follower.poll(), /before rotation/);
    assert.match(follower.poll(), /after rotation/);
    assert.equal(follower.poll(), "");
  } finally {
    follower.close();
  }
});

test("tray opens a real file with retained failures and journal diagnostics without HTTP", async () => {
  const dataDir = home("opening");
  mkdirSync(join(dataDir, "server"), { recursive: true });
  writeFileSync(join(dataDir, "server", "crash.log"), "Legacy startup failure\n");
  let opened = "";
  const path = await openLocalDiagnostics({
    dataDir,
    journal: async () => "Service stopped (SIGTERM)",
    openFile: async (file: string) => {
      opened = file;
    },
  });
  assert.equal(opened, path);
  assert.doesNotMatch(opened, /^https?:/);
  const text = readFileSync(opened, "utf8");
  assert.match(text, /Legacy startup failure/);
  assert.match(text, /Service stopped \(SIGTERM\)/);
});

test("local logs remain usable when every HTTP request fails", async () => {
  const previous = process.env.DATA_DIR;
  const fetch = globalThis.fetch;
  const dataDir = home("offline-cli");
  const exportPath = join(root, "offline.txt");
  process.env.DATA_DIR = dataDir;
  let httpCalls = 0;
  globalThis.fetch = async () => {
    httpCalls++;
    throw new Error("Router is offline");
  };
  try {
    appendRuntimeLog("Startup timed out", { dataDir });
    assert.equal(await runLogsCommand({ source: "runtime", export: exportPath }), 0);
    assert.match(readFileSync(exportPath, "utf8"), /Startup timed out/);
    assert.equal(httpCalls, 0);
    assert.equal(await runLogsCommand({ source: "runtime", lines: "NaN" }), 2);
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});

test("explicit remote contexts and request filters retain the API log path", () => {
  assert.equal(resolveLogSource({ context: "remote" }), "requests");
  assert.equal(resolveLogSource({ baseUrl: "http://router.example" }), "requests");
  assert.equal(resolveLogSource({ requestId: "request-1" }), "requests");
  assert.equal(resolveLogSource({ source: "requests" }), "requests");
  assert.equal(resolveLogSource({ context: "remote", source: "runtime" }), "runtime");
  assert.equal(resolveLogSource({ open: true }), "runtime");
});

test("the serve console is teed before early startup failure and still reaches the terminal", () => {
  const dataDir = home("early-startup");
  const entry = new URL("../../../bin/cli/runtime/localLogs.mjs", import.meta.url).href;
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      `import { captureConsoleDiagnostics } from ${JSON.stringify(entry)}; captureConsoleDiagnostics(); console.error('Server not found before HTTP startup'); process.stdout.write('terminal still works\\n');`,
    ],
    {
      env: { ...process.env, DATA_DIR: dataDir, RED_ROUTER_DATA_DIR: dataDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  assert.match(result, /terminal still works/);
  assert.match(readLogTail(getRuntimeLogPath(dataDir)), /Server not found before HTTP startup/);
});
