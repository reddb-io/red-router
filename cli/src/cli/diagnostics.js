// Operational diagnostics only. Never attach this writer to interactive CLI
// output: API-key menus intentionally show credentials to their owner.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const MAX_BYTES = 10 * 1024 * 1024;
const TOTAL_FILES = 5; // Current plus .1 through .4, not five backups.
const MAX_LINE_BYTES = 64 * 1024;
const LOCK_GRACE_MS = 30000;
// How long an append waits for the lock before dropping its line: logging must
// never stall the launcher.
const LOCK_WAIT_MS = 200;
const PAYLOAD = /(?:["']?(?:body|messages|prompt|content|request[-_ ]?body|response[-_ ]?body)["']?\s*[:=]|\bprovider error\b[^\n]*:|^\s*\{\s*(?:["']|$)|^\s*\[\s*$)/i;
const SECRET_CONTINUATION = /["']?(?:authorization|proxy-authorization|set-cookie|cookie|[\w-]*(?:token|secret|password|api[-_]?key))["']?\s*[:=]\s*(?:[\{\[])?\s*$/i;
const RECORD_START = /^(?:\[\d{2}:\d{2}:\d{2}\]|\d{4}-\d{2}-\d{2}T|timestamp=|\[(?:INFO|WARN|ERROR|DEBUG)\]|(?:INFO|WARN|ERROR|DEBUG)\s)/;

function logPath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const absolute = (value) => value && paths.isAbsolute(value);
  let root;
  if (platform === "win32") root = paths.join(absolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : paths.join(home, "AppData", "Local"), "red-router", "logs");
  else if (platform === "darwin") root = paths.join(home, "Library", "Logs", "red-router");
  else root = paths.join(absolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : paths.join(home, ".local", "state"), "red-router", "logs");
  return paths.join(root, "red-router.log");
}

function redact(text, secrets = []) {
  // eslint-disable-next-line no-control-regex -- Strip ANSI terminal control sequences before writing text files.
  let safe = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const secret of secrets) if (secret && secret.length >= 4) safe = safe.split(secret).join("[redacted]");
  safe = safe
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[redacted authorization]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:sk|rk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted key]")
    // Suppress whole fields, not just a credential prefix. Do not persist
    // body/prompt dumps embedded in ordinary diagnostic lines.
    .replace(/(["']?(?:authorization|proxy-authorization|set-cookie|cookie|[\w-]*(?:token|secret|password|api[-_]?key)|body|messages|prompt|content)["']?\s*[:=]\s*).*$/gim, "$1[redacted]");
  // Explicit payload diagnostics can be pretty-printed, so suppression covers
  // every continuation, not only the line containing "body:".
  const lines = String(text).split("\n");
  const firstPayload = lines.findIndex((line) => PAYLOAD.test(line) || SECRET_CONTINUATION.test(line));
  if (firstPayload >= 0) {
    const sanitized = safe.split("\n").slice(0, firstPayload);
    sanitized.push("[payload or multiline-sensitive diagnostic omitted]");
    return sanitized.join("\n");
  }
  return safe;
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error("unsafe log directory");
  fs.chmodSync(dir, 0o700);
}

function checkedFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe log file");
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function lockAbandoned(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error("unsafe diagnostic lock");
  const owner = path.join(dir, "owner");
  try {
    const pid = Number(fs.readFileSync(owner, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > LOCK_GRACE_MS;
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // mkdir may succeed immediately before a crash; do not evict a live process
    // in the tiny window before it writes its owner file.
    return Date.now() - stat.mtimeMs > LOCK_GRACE_MS;
  }
}

function removeLock(dir) {
  try { fs.unlinkSync(path.join(dir, "owner")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.rmdirSync(dir);
}

// All appends reopen the canonical filename under this same-host lock. Two
// launchers may briefly coexist during upgrades/tray handoff. A recovery guard
// serializes cleanup of a dead owner's lock; a live PID is never evicted.
function withLock(file, action, waitMs = LOCK_WAIT_MS) {
  const lock = `${file}.lock`;
  const recovery = `${lock}.recovery`;
  const owner = path.join(lock, "owner");
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let acquired = false;
    try {
      if (fs.existsSync(recovery)) {
        // The recovery guard has its own owner: a crash while reclaiming a
        // dead writer must not disable logging for every future process.
        try { if (lockAbandoned(recovery)) removeLock(recovery); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (fs.existsSync(recovery)) throw Object.assign(new Error("recovering log lock"), { code: "EEXIST" });
      }
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
      fs.writeFileSync(owner, String(process.pid), { mode: 0o600, flag: "wx" });
      return action();
    } catch (error) {
      if (acquired || error.code !== "EEXIST") throw error;
      let recovering = false;
      try {
        fs.mkdirSync(recovery, { mode: 0o700 });
        recovering = true;
        fs.writeFileSync(path.join(recovery, "owner"), String(process.pid), { mode: 0o600, flag: "wx" });
        if (lockAbandoned(lock)) removeLock(lock);
      } catch (recoveryError) {
        if (!["EEXIST", "ENOENT"].includes(recoveryError.code)) throw recoveryError;
      } finally {
        if (recovering) removeLock(recovery);
      }
      if (Date.now() >= deadline) throw new Error("diagnostic log busy");
      Atomics.wait(pause, 0, 0, 2);
    } finally {
      if (acquired) {
        removeLock(lock);
      }
    }
  }
}

function capExisting(file, maxBytes) {
  const stat = checkedFile(file);
  if (!stat) return;
  fs.chmodSync(file, 0o600);
  if (stat.size <= maxBytes) return;
  // Adopt only the bounded recent tail of an older oversized operational log.
  // Trim to a complete line so neither a UTF-8 character nor secret field is
  // split into an unrecognizable fragment during adoption.
  const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    const tail = Buffer.alloc(maxBytes);
    const length = fs.readSync(fd, tail, 0, maxBytes, stat.size - maxBytes);
    const newline = tail.indexOf(10, 0);
    const bytes = newline < 0 ? Buffer.from("[oversized previous diagnostic omitted]\n") : tail.subarray(newline + 1, length);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
  } finally { fs.closeSync(fd); }
}

function createDiagnostics({ file = logPath(), lockWaitMs = LOCK_WAIT_MS, maxBytes = MAX_BYTES, totalFiles = TOTAL_FILES, maxLineBytes = MAX_LINE_BYTES, warn = (message) => process.stderr.write(`${message}\n`), secrets = Object.entries(process.env).filter(([key]) => /token|secret|password|api_?key/i.test(key)).map(([, value]) => value) } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(totalFiles) || totalFiles < 1 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 32) throw new Error("invalid diagnostic log limits");
  let warned = false;
  function append(source, message) {
    try {
      privateDirectory(path.dirname(file));
      withLock(file, () => {
        for (let index = 0; index < totalFiles; index++) capExisting(index ? `${file}.${index}` : file, maxBytes);
        const prefix = `${new Date().toISOString()} pid=${process.pid} ${source} `;
        let entry = Buffer.from(`${prefix}${redact(message, secrets)}\n`);
        if (entry.length > maxBytes || Buffer.byteLength(String(message)) > maxLineBytes) entry = Buffer.from(`${prefix}[oversized diagnostic line omitted]\n`);
        const current = checkedFile(file);
        if (current && current.size + entry.length > maxBytes) {
          for (let index = totalFiles - 1; index >= 1; index--) {
            const previous = index === 1 ? file : `${file}.${index - 1}`;
            const target = `${file}.${index}`;
            checkedFile(target);
            if (checkedFile(previous)) {
              if (fs.existsSync(target)) fs.unlinkSync(target);
              fs.renameSync(previous, target);
              fs.chmodSync(target, 0o600);
            }
          }
          if (totalFiles === 1) fs.unlinkSync(file);
        }
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, entry); } finally { fs.closeSync(fd); }
      }, lockWaitMs);
      return true;
    } catch {
      if (!warned) {
        warned = true;
        try { warn(`[red-router] Cannot write diagnostic log: ${file}. Server continues; check directory permissions or another log writer.`); } catch { /* A broken stderr must not stop the gateway either. */ }
      }
      return false;
    }
  }
  function stream(source) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    let dropping = false;
    let suppressContinuations = false;
    function emit(line) {
      // Stream chunks have no record framing. Once a payload/multiline secret
      // begins, drop continuations until an explicit next diagnostic prefix.
      // This is intentionally conservative: losing an unframed debug line is
      // preferable to persisting part of a request body or credential.
      // eslint-disable-next-line no-control-regex -- Colored server prefixes still delimit diagnostic records.
      const clean = line.replace(/\r$/, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      if (suppressContinuations && !RECORD_START.test(clean)) return;
      suppressContinuations = PAYLOAD.test(clean) || SECRET_CONTINUATION.test(clean);
      append(source, clean);
    }
    function consume(text) {
      for (const fragment of text.split(/(\n)/)) {
        if (fragment === "\n") {
          if (dropping) { append(source, "[oversized diagnostic line omitted]"); suppressContinuations = true; }
          else if (pending) emit(pending);
          pending = "";
          bytes = 0;
          dropping = false;
        } else if (!dropping) {
          bytes += Buffer.byteLength(fragment);
          if (bytes > maxLineBytes) { pending = ""; dropping = true; }
          else pending += fragment;
        }
      }
    }
    return {
      write(chunk) { consume(typeof chunk === "string" ? chunk : decoder.write(chunk)); },
      end() {
        consume(decoder.end());
        if (dropping) append(source, "[oversized diagnostic line omitted]");
        else if (pending) emit(pending);
        pending = "";
        bytes = 0;
        dropping = false;
      },
    };
  }
  return { file, append, stream };
}

let diagnostics;
function getDiagnostics() {
  if (!diagnostics) diagnostics = createDiagnostics();
  return diagnostics;
}

function observeRuntime(name, ensure, diagnostics = getDiagnostics()) {
  try {
    const result = ensure();
    // Only the runtime's boolean status fields are persisted, never npm output
    // or environment/configuration values that might contain registry tokens.
    const status = Object.entries(result || {}).filter(([, value]) => typeof value === "boolean").map(([key, value]) => `${key}=${value}`).join(" ");
    diagnostics.append("bootstrap", `${name} runtime checked ${status}`);
    return result;
  } catch (error) {
    diagnostics.append("bootstrap", `${name} runtime failed: ${error.stack || error.message || error}`);
    return undefined;
  }
}

function captureServerOutput(child, { diagnostics = getDiagnostics(), showLog = false, stdout = process.stdout, stderr = process.stderr, onStderr = () => {} } = {}) {
  for (const [name, destination] of [["stdout", stdout], ["stderr", stderr]]) {
    if (!child[name]) continue;
    const output = diagnostics.stream(`server.${name}`);
    child[name].on("data", (chunk) => {
      output.write(chunk);
      if (name === "stderr") onStderr(chunk);
      if (showLog) destination.write(chunk);
    });
    child[name].once("end", () => output.end());
  }
}

async function openLog({ file = logPath(), platform = process.platform, spawnProcess = spawn } = {}) {
  if (!fs.existsSync(file) && !createDiagnostics({ file }).append("log", "Diagnostic log opened")) throw new Error(`Cannot create log file: ${file}`);
  checkedFile(file);
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, [file], { stdio: "ignore", windowsHide: true, detached: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
    // Acknowledges the OS launch only. Editors can remain open indefinitely;
    // never wait for their window to close or kill them on a timeout.
  });
}

module.exports = { MAX_BYTES, TOTAL_FILES, MAX_LINE_BYTES, logPath, redact, createDiagnostics, getDiagnostics, captureServerOutput, observeRuntime, openLog };
