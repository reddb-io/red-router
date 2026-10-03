import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";
import { resolveDataDir } from "../data-dir.mjs";
import { redactSensitiveErrorText } from "../../../open-sse/utils/errorSanitization.ts";

const runFile = promisify(execFile);
export const RUNTIME_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const RUNTIME_LOG_BACKUPS = 3;
const MAX_LINE_CHARS = 4096;
const TAIL_BYTES = 512 * 1024;

export function getRuntimeLogPath(dataDir = resolveDataDir()) {
  return join(dataDir, "server", "runtime.log");
}

export function getDiagnosticLogPath(dataDir = resolveDataDir()) {
  return join(dataDir, "server", "diagnostics.txt");
}

function privateFile(path, flags) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, flags | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Best effort: diagnostic I/O must never interrupt routing or shutdown. */
export function appendRuntimeLog(
  text,
  {
    dataDir = resolveDataDir(),
    channel = "cli",
    maxBytes = RUNTIME_LOG_MAX_BYTES,
    backups = RUNTIME_LOG_BACKUPS,
  } = {}
) {
  const path = getRuntimeLogPath(dataDir);
  try {
    const safe = redactSensitiveErrorText(stripVTControlCharacters(String(text)));
    const record = Buffer.from(`[${new Date().toISOString()}] [${channel}] ${safe}\n`);
    if (existsSync(path) && statSync(path).size + record.length > maxBytes) {
      for (let i = backups; i >= 1; i--) {
        const source = i === 1 ? path : `${path}.${i - 1}`;
        const target = `${path}.${i}`;
        if (existsSync(target)) unlinkSync(target);
        if (existsSync(source)) renameSync(source, target);
      }
    }
    const fd = privateFile(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY);
    try {
      writeSync(fd, record);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Decode whole lines so credentials split across pipe chunks stay redacted.
 * Drop oversized lines rather than persist a partially redacted credential. */
export function createRuntimeLogSink(options = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  function consume(text) {
    for (const part of text.split(/(?<=\n)/)) {
      const complete = part.endsWith("\n");
      if (!dropping) {
        if (pending.length + part.length > MAX_LINE_CHARS) {
          pending = "";
          dropping = true;
          appendRuntimeLog("[oversized log line omitted]", options);
        } else pending += part;
      }
      if (complete) {
        if (!dropping && pending.trim()) appendRuntimeLog(pending.trimEnd(), options);
        pending = "";
        dropping = false;
      }
    }
  }
  return {
    write(chunk, encoding) {
      consume(typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk, encoding)));
    },
    flush() {
      consume(decoder.end());
      if (!dropping && pending.trim()) appendRuntimeLog(pending, options);
      pending = "";
      dropping = false;
    },
  };
}

let consoleCaptureInstalled = false;
/** Install once for the lifetime of serve; retain terminal output and callbacks. */
export function captureConsoleDiagnostics() {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;
  const sinks = [];
  for (const [stream, channel] of [
    [process.stdout, "cli.stdout"],
    [process.stderr, "cli.stderr"],
  ]) {
    const sink = createRuntimeLogSink({ channel });
    const original = stream.write;
    stream.write = function (chunk, encoding, callback) {
      sink.write(chunk, typeof encoding === "string" ? encoding : undefined);
      return original.call(this, chunk, encoding, callback);
    };
    sinks.push(sink);
  }
  appendRuntimeLog(`serve started (pid=${process.pid})`);
  process.once("exit", (code) => {
    for (const sink of sinks) sink.flush();
    appendRuntimeLog(`CLI exited (code=${code})`);
  });
}

/** Read only a bounded suffix, even from legacy unbounded crash logs. */
export function readLogTail(path, lines = 100) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, count).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    return text.trimEnd().split("\n").slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    return `[Unable to read ${path}: ${error.code || "I/O error"}]`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readManagedJournal(lines = 100) {
  if (process.platform !== "linux") return "";
  try {
    const { stdout } = await runFile(
      "journalctl",
      [
        "--user",
        "-u",
        "red-router.service",
        "-u",
        "red-router-tray.service",
        "-n",
        String(lines),
        "--no-pager",
        "-o",
        "short-iso",
      ],
      { timeout: 3000, maxBuffer: TAIL_BYTES, windowsHide: true }
    );
    return stdout.trim();
  } catch (error) {
    return `[Managed service journal unavailable: ${error.code || "I/O error"}]`;
  }
}

function redactLines(text) {
  return String(text)
    .split("\n")
    .map((line) => redactSensitiveErrorText(stripVTControlCharacters(line)))
    .join("\n");
}

export async function collectLocalDiagnostics({
  dataDir = resolveDataDir(),
  lines = 100,
  journal = readManagedJournal,
} = {}) {
  const sections = [
    `RedRouter local diagnostics — ${new Date().toISOString()}`,
    `Data directory: ${dataDir}`,
  ];
  for (let i = RUNTIME_LOG_BACKUPS; i >= 0; i--) {
    const path = `${getRuntimeLogPath(dataDir)}${i ? `.${i}` : ""}`;
    const tail = readLogTail(path, lines);
    if (tail) sections.push(`--- ${path} ---`, tail);
  }
  const crashPath = join(dataDir, "server", "crash.log");
  const crash = readLogTail(crashPath, lines);
  if (crash) sections.push(`--- ${crashPath} ---`, crash);
  const managed = await journal(lines);
  if (managed) sections.push("--- Local managed server / tray journal ---", managed);
  if (sections.length === 2) sections.push("No local runtime diagnostics recorded yet.");
  return redactLines(sections.join("\n") + "\n");
}

export async function writeDiagnosticSnapshot(options = {}) {
  const path = getDiagnosticLogPath(options.dataDir);
  const text = await collectLocalDiagnostics(options);
  const fd = privateFile(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY);
  try {
    writeFileSync(fd, text, "utf8");
  } finally {
    closeSync(fd);
  }
  return path;
}

export async function openLocalDiagnostics(options = {}) {
  const path = await writeDiagnosticSnapshot(options);
  const openFile = options.openFile || (await import("open")).default;
  await openFile(path, { wait: false });
  return path;
}

/** Keep the old descriptor until drained, then reopen after rotation. */
export function createRuntimeLogFollower(dataDir = resolveDataDir()) {
  const path = getRuntimeLogPath(dataDir);
  let fd;
  let offset = 0;
  let identity = "";
  const decoder = new StringDecoder("utf8");
  function attach(atEnd = false) {
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = fstatSync(fd);
      identity = `${info.dev}:${info.ino}`;
      offset = atEnd ? info.size : 0;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  attach(true);
  return {
    poll() {
      if (fd === undefined) attach();
      let text = "";
      if (fd !== undefined) {
        const size = fstatSync(fd).size;
        if (size < offset) offset = 0;
        const bytes = Math.min(Math.max(0, size - offset), TAIL_BYTES);
        if (bytes) {
          const buffer = Buffer.alloc(bytes);
          const count = readSync(fd, buffer, 0, bytes, offset);
          offset += count;
          text += decoder.write(buffer.subarray(0, count));
        }
        // First drain writes to the renamed file, then switch to the new file.
        if (offset >= size) {
          try {
            const info = statSync(path);
            if (`${info.dev}:${info.ino}` !== identity) {
              text += decoder.end();
              closeSync(fd);
              fd = undefined;
              attach();
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
      return text;
    },
    close() {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
    },
  };
}
