/**
 * Supervisor for the `wireproxy` child processes that provide WireGuard egress.
 *
 * One process per profile. Each is a WireGuard client in user space (no root, no TUN device) that
 * exposes a loopback SOCKS5 listener; RedRouter registers that listener in the outbound-proxy
 * registry (see `egressService.ts`). This module only owns the process lifecycle:
 *
 *   stopped -> starting -> running          (listener accepted a TCP connection)
 *                  \-> error -> (backoff) -> starting ...   (crash, bounded restarts)
 *
 * Handling rules:
 *  - The rendered config holds the private key, so it is written to a 0600 file inside a 0700
 *    directory under DATA_DIR and deleted as soon as the process is gone (stop, crash, shutdown).
 *    It is the only place key material touches disk outside the encrypted database.
 *  - argv is `["-c", <file>]`: no key material on the command line. The environment is minimal
 *    (PATH and private HOME/TMPDIR; on Windows the few variables the OS loader needs). The server's
 *    own secrets, proxy variables and tokens never reach the child.
 *  - Readiness is a TCP connect to the SOCKS port, never log parsing. Note this proves the
 *    listener is up, not that the WireGuard handshake completed.
 *  - Crashes restart with exponential backoff and a bounded budget; a run that stayed up for
 *    `stableAfterMs` resets the budget. A start that fails for a reason a retry cannot fix (no
 *    binary, unreadable config, spawn error) is terminal.
 *  - Every error string that reaches state is redacted: key-shaped tokens, secrets pulled from the
 *    rendered config, and file paths.
 */

import { spawn as realSpawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import net from "net";
import path from "path";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { getWireGuardEgressRuntimeDir, resolveWireproxyBinary } from "./egressBinary";
import type { WireproxyResolution } from "./egressBinary";

const MAX_ERROR_LENGTH = 200;
const MAX_STDERR_TAIL = 2048;

export type EgressPhase = "stopped" | "starting" | "running" | "error";

/** Everything the rest of the app may know about a process. No config text, no keys, no paths. */
export type EgressProcessStatus = {
  id: string;
  phase: EgressPhase;
  pid: number | null;
  socksPort: number | null;
  lastError: string | null;
  /** Restarts used in the current budget. */
  restarts: number;
  /** Milliseconds until the next restart attempt, or null. */
  retryInMs: number | null;
};

export type EgressSpec = {
  id: string;
  socksPort: number;
  /** Rendered wireproxy config. Called on every (re)start so a restart never holds stale text. */
  loadConfig: () => string;
};

export type EgressFs = {
  ensurePrivateDir: (dir: string) => Promise<void>;
  writePrivateFile: (file: string, content: string) => Promise<void>;
  removeFile: (file: string) => Promise<void>;
  removeFileSync: (file: string) => void;
};

export type EgressRuntime = {
  spawn: typeof realSpawn;
  resolveBinary: () => Promise<WireproxyResolution>;
  probePort: (port: number, timeoutMs: number) => Promise<boolean>;
  findFreePort: () => Promise<number>;
  runtimeDir: () => string;
  fs: EgressFs;
  startTimeoutMs: number;
  probeIntervalMs: number;
  stopTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRestarts: number;
  stableAfterMs: number;
};

export async function probeTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const realFs: EgressFs = {
  async ensurePrivateDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      /* best effort (Windows / foreign owner) */
    }
  },
  async writePrivateFile(file, content) {
    await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
    try {
      // `mode` only applies on creation; tighten a pre-existing file too.
      await fs.chmod(file, 0o600);
    } catch {
      /* best effort */
    }
  },
  async removeFile(file) {
    await fs.rm(file, { force: true });
  },
  removeFileSync(file) {
    try {
      fsSync.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  },
};

const defaultRuntime = (): EgressRuntime => ({
  spawn: realSpawn,
  resolveBinary: resolveWireproxyBinary,
  probePort: probeTcpPort,
  findFreePort: findFreeLoopbackPort,
  runtimeDir: getWireGuardEgressRuntimeDir,
  fs: realFs,
  startTimeoutMs: 20_000,
  probeIntervalMs: 200,
  stopTimeoutMs: 5_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxRestarts: 8,
  stableAfterMs: 60_000,
});

let runtime: EgressRuntime = defaultRuntime();

/** Test seam: override spawn / binary / probe / fs / timings, or pass `null` to restore the real ones. */
export function setWireGuardEgressRuntime(overrides: Partial<EgressRuntime> | null): void {
  runtime = overrides ? { ...defaultRuntime(), ...overrides } : defaultRuntime();
}

export function getWireGuardEgressRuntime(): EgressRuntime {
  return runtime;
}

// --- redaction ------------------------------------------------------------------------------------

/** Strip key-shaped tokens, the given secrets and file paths from text bound for state or logs. */
export function redactEgressText(text: string, secrets: readonly string[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  // 32-byte base64 WireGuard keys, and anything else long and token-shaped.
  out = out.replace(/[A-Za-z0-9+/]{43}=/g, "[redacted]");
  out = out.replace(/[A-Za-z0-9+/=_-]{60,}/g, "[redacted]");
  out = out.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@ -]+){2,}/g, "[path]");
  out = sanitizeErrorMessage(out.replace(/\s+/g, " ").trim());
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH)}...` : out;
}

/** Secret values inside a rendered wireproxy config, for literal redaction. */
export function extractConfigSecrets(configText: string): string[] {
  const secrets: string[] = [];
  for (const line of String(configText).split("\n")) {
    const match = /^\s*(PrivateKey|PresharedKey|Password|Username)\s*=\s*(.+?)\s*$/i.exec(line);
    if (match) secrets.push(match[2]);
  }
  return secrets;
}

/** The child environment: PATH plus a private HOME/TMPDIR. Nothing else from the server's env. */
export function buildEgressChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeDir: string = runtime.runtimeDir()
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys =
    process.platform === "win32"
      ? ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
      : ["PATH"];
  for (const key of keys) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  const home = path.join(runtimeDir, "home");
  env.HOME = home;
  env.USERPROFILE = home;
  env.TMPDIR = path.join(runtimeDir, "tmp");
  return env;
}

/** The exact argv wireproxy is started with. The config path is the only variable part. */
export function getEgressArgs(configPath: string): string[] {
  return ["-c", configPath];
}

// --- state ----------------------------------------------------------------------------------------

type ChildState = { child: ChildProcess; exited: boolean };

type Entry = {
  spec: EgressSpec;
  current: ChildState | null;
  phase: EgressPhase;
  lastError: string | null;
  /** Restarts used in the current budget. */
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  retryAt: number | null;
  configPath: string | null;
  runningSince: number | null;
  /** Bumped by every start and stop; stale readiness loops and exit handlers compare against it. */
  generation: number;
  stderrTail: string;
  secrets: string[];
  settle: (() => void) | null;
  pending: Promise<void> | null;
  /** The config-file removal in flight, so a caller can wait for the key file to be gone. */
  removal: Promise<void> | null;
};

type Store = {
  entries: Map<string, Entry>;
  listeners: Set<(status: EgressProcessStatus) => void>;
  exitHookInstalled: boolean;
};

// Next.js hot reload re-evaluates modules; keep the live children on globalThis.
const GLOBAL_KEY = "__redrouterWireGuardEgress";
function store(): Store {
  const holder = globalThis as unknown as Record<string, Store | undefined>;
  if (!holder[GLOBAL_KEY]) {
    holder[GLOBAL_KEY] = { entries: new Map(), listeners: new Set(), exitHookInstalled: false };
  }
  return holder[GLOBAL_KEY] as Store;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function statusOf(entry: Entry): EgressProcessStatus {
  const live = entry.current && !entry.current.exited ? entry.current.child : null;
  return {
    id: entry.spec.id,
    phase: entry.phase,
    pid: live?.pid ?? null,
    socksPort: entry.spec.socksPort,
    lastError: entry.phase === "running" ? null : entry.lastError,
    restarts: entry.restarts,
    retryInMs: entry.retryAt === null ? null : Math.max(0, entry.retryAt - Date.now()),
  };
}

function emit(entry: Entry): void {
  const status = statusOf(entry);
  for (const listener of [...store().listeners]) {
    try {
      listener(status);
    } catch {
      /* a listener must never break supervision */
    }
  }
}

/** Subscribe to every phase change of every profile. Returns an unsubscribe function. */
export function onEgressStateChange(listener: (status: EgressProcessStatus) => void): () => void {
  const listeners = store().listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEgressProcessStatus(id: string): EgressProcessStatus {
  const entry = store().entries.get(id);
  if (!entry) {
    return {
      id,
      phase: "stopped",
      pid: null,
      socksPort: null,
      lastError: null,
      restarts: 0,
      retryInMs: null,
    };
  }
  return statusOf(entry);
}

function installExitHook(): void {
  const s = store();
  if (s.exitHookInstalled) return;
  s.exitHookInstalled = true;
  // Last resort when the server exits without the graceful path: never orphan a tunnel or leave
  // a key file behind. Synchronous by necessity.
  process.on("exit", () => {
    for (const entry of s.entries.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      const live = entry.current && !entry.current.exited ? entry.current.child : null;
      try {
        live?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      if (entry.configPath) runtime.fs.removeFileSync(entry.configPath);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(state: ChildState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) await sleep(25);
  return state.exited;
}

async function killChild(state: ChildState | null): Promise<void> {
  if (!state || state.exited) return;
  try {
    state.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  if (!(await waitForExit(state, runtime.stopTimeoutMs))) {
    try {
      state.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForExit(state, runtime.stopTimeoutMs);
  }
}

async function removeConfigFile(entry: Entry): Promise<void> {
  const file = entry.configPath;
  entry.configPath = null;
  if (file) {
    entry.removal = runtime.fs.removeFile(file).catch(() => {});
  }
  if (entry.removal) await entry.removal;
}

function terminalFailure(entry: Entry, message: string): void {
  entry.phase = "error";
  entry.lastError = message;
  entry.retryAt = null;
  emit(entry);
  entry.settle?.();
}

/** One spawn + readiness attempt. Resolves when the attempt settled (running or failed). */
async function runAttempt(entry: Entry): Promise<void> {
  const generation = entry.generation;
  const settled = new Promise<void>((resolve) => {
    entry.settle = resolve;
  });
  entry.phase = "starting";
  entry.lastError = null;
  entry.retryAt = null;
  entry.stderrTail = "";
  emit(entry);

  const stale = () => generation !== entry.generation;

  let binaryPath: string | null = null;
  try {
    binaryPath = (await runtime.resolveBinary()).binaryPath;
  } catch {
    binaryPath = null;
  }
  if (stale()) return;
  if (!binaryPath) {
    terminalFailure(entry, "wireproxy is not installed.");
    return settled;
  }

  let configText: string;
  try {
    configText = entry.spec.loadConfig();
  } catch {
    terminalFailure(entry, "The stored WireGuard configuration could not be loaded.");
    return settled;
  }
  entry.secrets = extractConfigSecrets(configText);

  const dir = runtime.runtimeDir();
  const configPath = path.join(dir, `${entry.spec.id}.conf`);
  try {
    await runtime.fs.ensurePrivateDir(dir);
    await runtime.fs.ensurePrivateDir(path.join(dir, "home"));
    await runtime.fs.ensurePrivateDir(path.join(dir, "tmp"));
    await runtime.fs.writePrivateFile(configPath, configText);
  } catch {
    terminalFailure(entry, "Could not write the runtime configuration.");
    return settled;
  }
  entry.configPath = configPath;
  if (stale()) {
    await removeConfigFile(entry);
    return;
  }

  let child: ChildProcess;
  try {
    child = runtime.spawn(binaryPath, getEgressArgs(configPath), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildEgressChildEnv(process.env, dir),
    });
  } catch {
    await removeConfigFile(entry);
    terminalFailure(entry, "wireproxy failed to start.");
    return settled;
  }
  if (!child.pid) {
    await removeConfigFile(entry);
    terminalFailure(entry, "wireproxy failed to start.");
    return settled;
  }

  const state: ChildState = { child, exited: false };
  entry.current = state;

  const onOutput = (chunk: Buffer | string) => {
    // Keep only a short tail for the error message; output is otherwise discarded (it can name
    // endpoints and, on bad input, echo config fragments).
    entry.stderrTail = `${entry.stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_TAIL);
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);

  child.once("error", () => {
    state.exited = true;
    if (stale()) return;
    void removeConfigFile(entry);
    terminalFailure(entry, "wireproxy failed to start.");
  });

  child.once("exit", (code, signal) => {
    state.exited = true;
    void (async () => {
      // The key file goes first, before anything else reacts to the exit.
      await removeConfigFile(entry);
      if (stale()) return;
      const wasRunningFor = entry.runningSince === null ? 0 : Date.now() - entry.runningSince;
      entry.runningSince = null;
      if (wasRunningFor >= runtime.stableAfterMs) entry.restarts = 0;
      const tail = entry.stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      entry.lastError =
        entry.lastError ||
        (tail
          ? redactEgressText(tail, entry.secrets)
          : `wireproxy exited unexpectedly (${code ?? signal ?? "unknown"}).`);
      entry.phase = "error";
      if (entry.restarts >= runtime.maxRestarts) {
        entry.retryAt = null;
        entry.lastError = `${entry.lastError} Restart limit reached.`;
        emit(entry);
        entry.settle?.();
        return;
      }
      entry.restarts += 1;
      const delay = Math.min(
        runtime.backoffBaseMs * 2 ** (entry.restarts - 1),
        runtime.backoffMaxMs
      );
      entry.retryAt = Date.now() + delay;
      emit(entry);
      entry.settle?.();
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null;
        if (generation !== entry.generation) return;
        entry.pending = runAttempt(entry).catch(() => {});
      }, delay);
      entry.restartTimer.unref?.();
    })();
  });

  // Readiness: a TCP connect to the SOCKS listener, never a log line.
  const deadline = Date.now() + runtime.startTimeoutMs;
  let ready = false;
  while (!stale() && !state.exited && Date.now() < deadline) {
    if (await runtime.probePort(entry.spec.socksPort, 500)) {
      ready = !stale() && !state.exited;
      break;
    }
    await sleep(runtime.probeIntervalMs);
  }
  if (stale()) return;
  if (ready) {
    entry.phase = "running";
    entry.lastError = null;
    entry.runningSince = Date.now();
    emit(entry);
    entry.settle?.();
  } else if (!state.exited) {
    // Timed out: kill it; the exit handler records the failure and schedules the retry.
    entry.lastError = "Timed out waiting for the SOCKS5 listener.";
    void killChild(state);
  }
  return settled;
}

/**
 * Start (or join the start of) a profile's process. Resolves once the first attempt settled, with
 * the resulting status: `running`, or `error` (which may still be retried in the background).
 * Never rejects for an operational failure.
 */
export async function startEgressProcess(spec: EgressSpec): Promise<EgressProcessStatus> {
  if (!SAFE_ID.test(spec.id)) throw new Error("Invalid profile id");
  installExitHook();
  const s = store();
  let entry = s.entries.get(spec.id);
  if (entry && (entry.phase === "running" || (entry.phase === "starting" && entry.pending))) {
    if (entry.pending) await entry.pending;
    return statusOf(entry);
  }
  if (entry) {
    // Re-start from error / stopped: cancel any pending retry and take the new spec.
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
    entry.generation += 1;
    await killChild(entry.current);
    await removeConfigFile(entry);
    entry.spec = spec;
    entry.restarts = 0;
  } else {
    entry = {
      spec,
      current: null,
      phase: "stopped",
      lastError: null,
      restarts: 0,
      restartTimer: null,
      retryAt: null,
      configPath: null,
      runningSince: null,
      generation: 0,
      stderrTail: "",
      secrets: [],
      settle: null,
      pending: null,
      removal: null,
    };
    s.entries.set(spec.id, entry);
  }
  entry.generation += 1;
  const attempt = runAttempt(entry).catch(() => {});
  entry.pending = attempt;
  await attempt;
  return statusOf(entry);
}

/** Stop a profile: cancel retries, SIGTERM (then SIGKILL), delete the config file. Idempotent. */
export async function stopEgressProcess(id: string): Promise<EgressProcessStatus> {
  const entry = store().entries.get(id);
  if (!entry) return getEgressProcessStatus(id);
  entry.generation += 1;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  entry.restartTimer = null;
  entry.retryAt = null;
  const state = entry.current;
  await killChild(state);
  await removeConfigFile(entry);
  entry.current = null;
  entry.runningSince = null;
  entry.phase = "stopped";
  entry.lastError = null;
  entry.restarts = 0;
  entry.pending = null;
  entry.settle?.();
  emit(entry);
  return statusOf(entry);
}

export async function restartEgressProcess(spec: EgressSpec): Promise<EgressProcessStatus> {
  await stopEgressProcess(spec.id);
  return startEgressProcess(spec);
}

/** Forget a stopped profile's in-memory entry (after deletion). */
export function forgetEgressProcess(id: string): void {
  const entry = store().entries.get(id);
  if (entry && (entry.phase === "stopped" || entry.phase === "error")) store().entries.delete(id);
}

/** Stop every process. Used on server shutdown; touches no database. */
export async function stopAllEgressProcesses(): Promise<void> {
  const ids = [...store().entries.keys()];
  await Promise.all(ids.map((id) => stopEgressProcess(id).catch(() => undefined)));
}

export function listEgressProcessStatuses(): EgressProcessStatus[] {
  return [...store().entries.values()].map(statusOf);
}
