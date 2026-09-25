import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import diagnosticsModule from "../../cli/src/cli/diagnostics.js";

const { MAX_BYTES, TOTAL_FILES, logPath, redact, createDiagnostics, captureServerOutput, observeRuntime, openLog, abandonedInstance, evictAbandoned } = diagnosticsModule;
const cli = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
const modulePath = fileURLToPath(new URL("../../cli/src/cli/diagnostics.js", import.meta.url));
const directories = [];
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-log-test-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("operational diagnostic locations and discovery", () => {
  it("resolves state roots without cwd or package-install paths", () => {
    expect(logPath({ platform: "linux", env: {}, home: "/users/a" })).toBe("/users/a/.local/state/red-router/logs/red-router.log");
    expect(logPath({ platform: "linux", env: { XDG_STATE_HOME: "/state folder" }, home: "/users/a" })).toBe("/state folder/red-router/logs/red-router.log");
    expect(logPath({ platform: "linux", env: { XDG_STATE_HOME: "relative" }, home: "/users/a" })).toBe("/users/a/.local/state/red-router/logs/red-router.log");
    expect(logPath({ platform: "win32", env: { LOCALAPPDATA: "D:\\User data" }, home: "C:\\Users\\a" })).toBe("D:\\User data\\red-router\\logs\\red-router.log");
    expect(logPath({ platform: "win32", env: {}, home: "C:\\Users\\a" })).toBe("C:\\Users\\a\\AppData\\Local\\red-router\\logs\\red-router.log");
    expect(logPath({ platform: "darwin", env: {}, home: "/Users/a" })).toBe("/Users/a/Library/Logs/red-router/red-router.log");
  });

  it("prints only the path without runtime install or filesystem writes", () => {
    const state = temporary();
    const output = execFileSync(process.execPath, [cli, "logs", "--path"], { encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: state }, timeout: 5000 });
    expect(output).toBe(`${path.join(state, "red-router/logs/red-router.log")}\n`);
    expect(fs.readdirSync(state)).toEqual([]);
  });
});

describe("bounded private rotating log", () => {
  it("keeps five total files during writes and after restart", () => {
    expect(MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(TOTAL_FILES).toBe(5);
    const file = path.join(temporary(), "logs", "red-router.log");
    let logger = createDiagnostics({ file, maxBytes: 256, secrets: [] });
    for (let i = 0; i < 30; i++) {
      if (i === 15) logger = createDiagnostics({ file, maxBytes: 256, secrets: [] });
      expect(logger.append("server.stdout", `record-${i}-${"x".repeat(100)}`)).toBe(true);
    }
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(["red-router.log", "red-router.log.1", "red-router.log.2", "red-router.log.3", "red-router.log.4"]);
    expect(fs.readFileSync(file, "utf8")).toContain("record-29-");
    expect(fs.readFileSync(`${file}.4`, "utf8")).toContain("record-25-");
    for (let i = 0; i < 5; i++) {
      const stat = fs.statSync(i ? `${file}.${i}` : file);
      expect(stat.size).toBeLessThanOrEqual(256);
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("handles a single oversized record without exceeding the cap", () => {
    const file = path.join(temporary(), "red-router.log");
    expect(createDiagnostics({ file, maxBytes: 128 }).append("server", "x".repeat(10000))).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(128);
    expect(fs.readFileSync(file, "utf8")).toContain("oversized diagnostic line omitted");
  });

  it("reopens the current filename after a rename", () => {
    const file = path.join(temporary(), "red-router.log");
    const logger = createDiagnostics({ file });
    logger.append("launcher", "before");
    fs.renameSync(file, `${file}.1`);
    logger.append("launcher", "after");
    expect(fs.readFileSync(file, "utf8")).toContain("after");
    expect(fs.readFileSync(`${file}.1`, "utf8")).not.toContain("after");
  });

  it("adopts oversized existing current and archive files without retaining an unbounded backup", () => {
    const file = path.join(temporary(), "red-router.log");
    for (let index = 0; index < 5; index++) fs.writeFileSync(index ? `${file}.${index}` : file, "old complete line\n".repeat(100), { mode: 0o644 });
    expect(createDiagnostics({ file, maxBytes: 128 }).append("launcher", "new record")).toBe(true);
    for (let index = 0; index < 5; index++) {
      const stat = fs.statSync(index ? `${file}.${index}` : file);
      expect(stat.size).toBeLessThanOrEqual(128);
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("assembles UTF8 and secrets split over chunks, flushing final lines", () => {
    const file = path.join(temporary(), "red-router.log");
    const output = createDiagnostics({ file, secrets: [] }).stream("server.stderr");
    const value = Buffer.from("Olá: authorization=Bearer split-secret\nhealthy 🐈\nlast line");
    for (let i = 0; i < value.length; i++) output.write(value.subarray(i, i + 1));
    output.end();
    const content = fs.readFileSync(file, "utf8");
    expect(content).not.toContain("split-secret");
    expect(content).not.toContain("�");
    expect(content).toContain("Olá:");
    expect(content).toContain("healthy 🐈");
    expect(content).toContain("last line");
  });

  it("drops an overlong line without leaking trailing fragments", () => {
    const file = path.join(temporary(), "red-router.log");
    const output = createDiagnostics({ file, maxLineBytes: 32 }).stream("server.stdout");
    output.write("authorization=" + "s".repeat(80));
    output.write("tail-secret\n[12:00:00] next safe line\n");
    output.end();
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("[oversized diagnostic line omitted]");
    expect(content).toContain("next safe line");
    expect(content).not.toContain("tail-secret");
    expect(content).not.toContain("authorization=");
  });

  it("redacts credentials, body/prompt fields, and known environment secrets", () => {
    const result = redact('Bearer sensitive-value\n{"body": "private conversation"}\nprompt="my question"\nhttps://user:pass@host/path?access_token=secret\napi_key: abc\nsk-abcdef12345678\nknown-value', ["known-value"]);
    for (const secret of ["sensitive-value", "private conversation", "my question", "user:pass", "=secret", "abc", "sk-abcdef12345678", "known-value"]) expect(result).not.toContain(secret);
  });

  it("suppresses pretty JSON bodies and multiline secrets across chunks until a new diagnostic record", () => {
    const file = path.join(temporary(), "red-router.log");
    const output = createDiagnostics({ file }).stream("server.stderr");
    for (const fragment of ["body:\n super private\n", "}\n[12:00:00] next request accepted\n", '{"api_key":"plain-secret"}\n', "{\n  \"other\": \"private dump\"\n}\n", "[12:00:01] healthy\nauthorization:\n continued-secret\n[12:00:02] ready\n"]) output.write(fragment);
    output.end();
    const content = fs.readFileSync(file, "utf8");
    for (const secret of ["super private", "plain-secret", "private dump", "continued-secret"]) expect(content).not.toContain(secret);
    expect(content).toContain("next request accepted");
    expect(content).toContain("healthy");
    expect(content).toContain("ready");
    expect(content).toContain("payload or multiline-sensitive diagnostic omitted");
    expect(redact("body:\nprivate\n}")).not.toContain("private");
    expect(redact("Cookie: sid=a; other=b")).not.toContain("other=b");
  });

  it("warns once without throwing on filesystem failure or following symlinks", () => {
    const directory = temporary();
    const file = path.join(directory, "red-router.log");
    fs.mkdirSync(file);
    const warn = vi.fn();
    const logger = createDiagnostics({ file, warn });
    expect(logger.append("launcher", "one")).toBe(false);
    expect(logger.append("launcher", "two")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    if (process.platform !== "win32") {
      const target = path.join(directory, "user-data");
      fs.writeFileSync(target, "unchanged");
      const link = path.join(directory, "symlink.log");
      fs.symlinkSync(target, link);
      expect(createDiagnostics({ file: link, warn: () => {} }).append("launcher", "overwrite")).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
    }
  });

  it("recovers an abandoned writer lock", () => {
    const file = path.join(temporary(), "red-router.log");
    fs.mkdirSync(`${file}.lock`);
    fs.writeFileSync(path.join(`${file}.lock`, "owner"), "2147483646");
    expect(createDiagnostics({ file }).append("launcher", "recovered")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("recovered");
  });

  it("recovers a process that died while holding the recovery guard", () => {
    const file = path.join(temporary(), "red-router.log");
    for (const suffix of [".lock", ".lock.recovery"]) {
      fs.mkdirSync(`${file}${suffix}`);
      fs.writeFileSync(path.join(`${file}${suffix}`, "owner"), "2147483646");
    }
    expect(createDiagnostics({ file }).append("launcher", "recovered guard")).toBe(true);
    expect(fs.existsSync(`${file}.lock.recovery`)).toBe(false);
  });

  it("recovers an old empty guard left before its owner could be written", () => {
    const file = path.join(temporary(), "red-router.log");
    fs.mkdirSync(`${file}.lock.recovery`);
    fs.utimesSync(`${file}.lock.recovery`, new Date(0), new Date(0));
    expect(createDiagnostics({ file }).append("launcher", "recovered empty guard")).toBe(true);
  });

  it("never evicts a live guard and treats a broken warning stream as nonfatal", () => {
    const file = path.join(temporary(), "red-router.log");
    fs.mkdirSync(`${file}.lock.recovery`);
    fs.writeFileSync(path.join(`${file}.lock.recovery`, "owner"), String(process.pid));
    fs.utimesSync(`${file}.lock.recovery`, new Date(0), new Date(0));
    const logger = createDiagnostics({ file, warn: () => { throw new Error("EPIPE"); } });
    expect(logger.append("launcher", "blocked")).toBe(false);
    expect(fs.readFileSync(path.join(`${file}.lock.recovery`, "owner"), "utf8")).toBe(String(process.pid));
  });

  // Processes that judge the same dead lock at once must not each remove "the
  // lock": the slower one would remove the live lock that replaced it. This is
  // what failed the concurrent test below now and then (a live guard removed
  // under its owner, whose own release then hit ENOENT or ENOTEMPTY).
  it("removes an abandoned lock once, never the live lock that replaced it", () => {
    const file = path.join(temporary(), "red-router.log");
    const lock = `${file}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "2147483646");
    // Two processes judge the same dead lock.
    const fast = abandonedInstance(lock);
    const slow = abandonedInstance(lock);
    expect(fast).toBeTruthy();
    expect(slow).toBe(fast);

    expect(evictAbandoned(lock, fast)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    // A live writer takes the lock before the slow process gets to evict.
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
    expect(abandonedInstance(lock)).toBeNull();

    expect(evictAbandoned(lock, slow)).toBe(false);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(String(process.pid));
  });

  it("frees a dead lock whose evicting process died before removing it", () => {
    const file = path.join(temporary(), "red-router.log");
    const lock = `${file}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), "2147483646");
    // The claim is left, the lock is not: the claimant crashed in between.
    const claim = `${lock}.evicted-${abandonedInstance(lock)}`;
    fs.mkdirSync(claim);
    fs.utimesSync(claim, new Date(0), new Date(0));
    expect(createDiagnostics({ file }).append("launcher", "after a crashed eviction")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("after a crashed eviction");
    expect(fs.existsSync(lock)).toBe(false);
  });

  // What is under test is serialization, not speed: the default 200 ms wait drops
  // a line on a loaded machine by design, so the writers here wait as long as needed.
  it("serializes concurrent processes without interleaved or dropped records", async () => {
    const file = path.join(temporary(), "red-router.log");
    // All contenders initially observe the same abandoned writer/recovery guard.
    for (const suffix of [".lock", ".lock.recovery"]) {
      fs.mkdirSync(`${file}${suffix}`);
      fs.writeFileSync(path.join(`${file}${suffix}`, "owner"), "2147483646");
    }
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const program = `const {createDiagnostics}=require(${JSON.stringify(modulePath)});const log=createDiagnostics({file:${JSON.stringify(file)},lockWaitMs:60000});for(let n=0;n<100;n++)if(!log.append("worker",${JSON.stringify(`worker-${index}:`)}+n))process.exitCode=1;`;
      const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "ignore", "pipe"] });
      let errors = "";
      child.stderr.on("data", (data) => { errors += data; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errors)));
    })));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(400);
    expect(new Set(lines.map((line) => line.match(/worker-\d+:\d+$/)?.[0])).size).toBe(400);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("server capture and file opener", () => {
  it("captures runtime bootstrap failures and only known status fields", () => {
    const file = path.join(temporary(), "red-router.log");
    const diagnostics = createDiagnostics({ file });
    expect(observeRuntime("SQLite", () => { throw new Error('install failed {"api_key":"registry-secret"}'); }, diagnostics)).toBeUndefined();
    observeRuntime("tray", () => ({ systray: false, stderr: "private npm output" }), diagnostics);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("SQLite runtime failed");
    expect(content).toContain("systray=false");
    expect(content).not.toContain("registry-secret");
    expect(content).not.toContain("private npm output");
    const source = fs.readFileSync(cli, "utf8");
    expect(source.indexOf("const diagnostics = getDiagnostics()")).toBeLessThan(source.indexOf('observeRuntime("SQLite"'));
  });
  it.each([false, true])("captures both streams independently of --log=%s", (showLog) => {
    const file = path.join(temporary(), "red-router.log");
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    captureServerOutput(child, { diagnostics: createDiagnostics({ file }), showLog, stdout, stderr });
    child.stdout.write("server ready\n");
    child.stderr.write("upstream unavailable\n");
    expect(fs.readFileSync(file, "utf8")).toContain("server ready");
    expect(fs.readFileSync(file, "utf8")).toContain("upstream unavailable");
    expect(stdout.write).toHaveBeenCalledTimes(showLog ? 1 : 0);
    expect(stderr.write).toHaveBeenCalledTimes(showLog ? 1 : 0);
  });

  it.each([["linux", "xdg-open"], ["darwin", "open"], ["win32", "explorer.exe"]])("launches the actual file without a shell or window-exit wait on %s", async (platform, command) => {
    const file = path.join(temporary(), "log with spaces;$(ignored).log");
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => { queueMicrotask(() => child.emit("spawn")); return child; });
    await openLog({ file, platform, spawnProcess });
    expect(spawnProcess).toHaveBeenCalledWith(command, [file], { stdio: "ignore", windowsHide: true, detached: true });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.listenerCount("close")).toBe(0);
    expect(fs.statSync(file).isFile()).toBe(true);
  });

  it("reports opener spawn failure", async () => {
    const file = path.join(temporary(), "red-router.log");
    const spawnProcess = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("opener unavailable")));
      return child;
    };
    await expect(openLog({ file, spawnProcess })).rejects.toThrow("opener unavailable");
  });
});
