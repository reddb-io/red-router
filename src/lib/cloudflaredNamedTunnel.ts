/**
 * Cloudflare Named Tunnel: a stable public hostname on the operator's own domain.
 *
 * The operator creates a tunnel in Cloudflare Zero Trust, maps a public hostname to
 * `http://localhost:<port>` there and pastes the tunnel token here. RedRouter then runs
 * `cloudflared tunnel --no-autoupdate run` as a child process. The token reaches cloudflared
 * through the `TUNNEL_TOKEN` environment variable, never through argv, so it never shows in `ps`,
 * and the child environment is the same allow-listed one the Quick Tunnel uses plus that one key.
 *
 * Secrets: the token lives encrypted in `src/lib/db/namedTunnelConfig.ts`. Nothing exported from
 * this module returns it, and every line of cloudflared output that reaches state or status is
 * passed through `redactNamedTunnelText()` first.
 *
 * The binary detection/install helper is the Quick Tunnel's (`cloudflaredTunnel.ts`), and
 * readiness is detected the way the named Quick-Tunnel mode does it: the first "registered tunnel
 * connection" log line.
 */

import { spawn as realSpawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import {
  buildCloudflaredChildEnv,
  ensureCloudflaredBinary,
  extractCloudflaredConnectionReady,
  extractCloudflaredErrorMessage,
  getCloudflaredAssetSpec,
  getCloudflaredRuntimeDirs,
  resolveCloudflaredBinary,
  type BinaryResolution,
} from "@/lib/cloudflaredTunnel";
import {
  clearNamedTunnelConfig,
  hasNamedTunnelToken,
  readNamedTunnelHostname,
  readNamedTunnelToken,
  saveNamedTunnelConfig,
} from "@/lib/db/namedTunnelConfig";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_ERROR_LENGTH = 200;

export type CloudflaredNamedTunnelPhase =
  "unsupported" | "not_configured" | "stopped" | "starting" | "running" | "error";

/** Everything the dashboard may see. There is deliberately no token field, only `hasToken`. */
export type CloudflaredNamedTunnelStatus = {
  supported: boolean;
  installed: boolean;
  configured: boolean;
  hasToken: boolean;
  hostname: string | null;
  running: boolean;
  pid: number | null;
  publicUrl: string | null;
  apiUrl: string | null;
  targetUrl: string;
  phase: CloudflaredNamedTunnelPhase;
  lastError: string | null;
  /** Whether client routes reject anonymous callers (REQUIRE_API_KEY). Drives the card notice. */
  requireApiKey: boolean;
};

export class NamedTunnelNotConfiguredError extends Error {
  constructor() {
    super("Cloudflare Named Tunnel is not configured");
    this.name = "NamedTunnelNotConfiguredError";
  }
}

/** The process/binary seams. Tests replace them; production uses the defaults. */
export type CloudflaredNamedTunnelRuntime = {
  spawn: typeof realSpawn;
  ensureBinary: () => Promise<BinaryResolution>;
  resolveBinary: () => Promise<BinaryResolution>;
  startTimeoutMs: number;
  stopTimeoutMs: number;
};

const defaultRuntime = (): CloudflaredNamedTunnelRuntime => ({
  spawn: realSpawn,
  ensureBinary: ensureCloudflaredBinary,
  resolveBinary: resolveCloudflaredBinary,
  startTimeoutMs: START_TIMEOUT_MS,
  stopTimeoutMs: STOP_TIMEOUT_MS,
});

let runtime: CloudflaredNamedTunnelRuntime = defaultRuntime();

/** Test seam: pass overrides, or `null` to restore the real spawn/binary helpers. */
export function setCloudflaredNamedTunnelRuntime(
  overrides: Partial<CloudflaredNamedTunnelRuntime> | null
): void {
  runtime = overrides ? { ...defaultRuntime(), ...overrides } : defaultRuntime();
}

type ProcessState = {
  child: ChildProcess | null;
  exited: boolean;
  phase: "stopped" | "starting" | "running" | "error";
  lastError: string | null;
};

// Next.js hot reload re-evaluates modules; keep the handle to the live child on globalThis.
const globalKey = "__redrouterCloudflaredNamedTunnel";
const globalStore = globalThis as unknown as Record<string, ProcessState | undefined>;
function proc(): ProcessState {
  if (!globalStore[globalKey]) {
    globalStore[globalKey] = { child: null, exited: true, phase: "stopped", lastError: null };
  }
  return globalStore[globalKey] as ProcessState;
}

let startPromise: Promise<CloudflaredNamedTunnelStatus> | null = null;

/** Strip the token and anything token-shaped, plus absolute paths, from text bound for state or status. */
export function redactNamedTunnelText(text: string, token = ""): string {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("[redacted]");
  out = out.replace(/[A-Za-z0-9+/=_-]{60,}/g, "[redacted]");
  out = out.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g, "[path]");
  out = sanitizeErrorMessage(out);
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH)}...` : out;
}

/** The exact arguments cloudflared is started with. The token is intentionally not among them. */
export function getCloudflaredNamedTunnelArgs(): string[] {
  return ["tunnel", "--no-autoupdate", "run"];
}

/** The child environment: the Quick Tunnel's allow-listed env plus TUNNEL_TOKEN. */
export function buildCloudflaredNamedTunnelEnv(token: string): NodeJS.ProcessEnv {
  return { ...buildCloudflaredChildEnv(), TUNNEL_TOKEN: token };
}

function isAlive(state: ProcessState): boolean {
  return !!state.child && !state.exited;
}

function getTargetUrl(): string {
  return `http://127.0.0.1:${getRuntimePorts().apiPort}`;
}

export async function getCloudflaredNamedTunnelStatus(): Promise<CloudflaredNamedTunnelStatus> {
  const state = proc();
  const binary = await runtime.resolveBinary();
  const hostname = readNamedTunnelHostname() || null;
  const hasToken = hasNamedTunnelToken();
  const configured = !!hostname && hasToken;
  const running = isAlive(state) && state.phase === "running";
  const supported = !!(getCloudflaredAssetSpec() || binary.binaryPath);

  let phase: CloudflaredNamedTunnelPhase;
  if (!supported) phase = "unsupported";
  else if (!configured) phase = "not_configured";
  else if (isAlive(state) && state.phase === "starting") phase = "starting";
  else if (running) phase = "running";
  else if (state.phase === "error" && state.lastError) phase = "error";
  else phase = "stopped";

  const publicUrl = running && hostname ? `https://${hostname}` : null;
  return {
    supported,
    installed: !!binary.binaryPath,
    configured,
    hasToken,
    hostname,
    running,
    pid: running ? (state.child?.pid ?? null) : null,
    publicUrl,
    apiUrl: publicUrl ? `${publicUrl}/v1` : null,
    targetUrl: getTargetUrl(),
    phase,
    lastError: running ? null : state.lastError,
    requireApiKey: isRequireApiKeyEnabled(),
  };
}

/** Save hostname (+ token). Does not start anything; a running tunnel must be restarted to pick it up. */
export function configureCloudflaredNamedTunnel(input: { hostname: string; token?: string }): void {
  if (!input.token && !hasNamedTunnelToken()) {
    throw new NamedTunnelNotConfiguredError();
  }
  saveNamedTunnelConfig(input);
  const state = proc();
  if (!isAlive(state)) {
    state.phase = "stopped";
    state.lastError = null;
  }
}

async function waitForExit(state: ProcessState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return state.exited;
}

async function killChild(state: ProcessState): Promise<void> {
  const child = state.child;
  if (!child || state.exited) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await waitForExit(state, runtime.stopTimeoutMs))) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await waitForExit(state, runtime.stopTimeoutMs);
  }
}

export async function stopCloudflaredNamedTunnel(): Promise<CloudflaredNamedTunnelStatus> {
  const state = proc();
  await killChild(state);
  state.child = null;
  state.exited = true;
  state.phase = "stopped";
  state.lastError = null;
  return getCloudflaredNamedTunnelStatus();
}

/** Stop the tunnel and delete the stored token and hostname. */
export async function clearCloudflaredNamedTunnel(): Promise<CloudflaredNamedTunnelStatus> {
  await stopCloudflaredNamedTunnel();
  clearNamedTunnelConfig();
  return getCloudflaredNamedTunnelStatus();
}

async function ensureRuntimeDirs(): Promise<void> {
  await Promise.all(
    Object.values(getCloudflaredRuntimeDirs()).map((dir) => fs.mkdir(dir, { recursive: true }))
  );
}

async function launch(): Promise<CloudflaredNamedTunnelStatus> {
  const token = readNamedTunnelToken();
  const hostname = readNamedTunnelHostname();
  if (!token || !hostname) throw new NamedTunnelNotConfiguredError();

  const binary = await runtime.ensureBinary();
  if (!binary.binaryPath) throw new Error("cloudflared is not installed");

  const state = proc();
  await killChild(state);
  await ensureRuntimeDirs();

  state.phase = "starting";
  state.lastError = null;
  state.exited = false;

  const child = runtime.spawn(binary.binaryPath, getCloudflaredNamedTunnelArgs(), {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildCloudflaredNamedTunnelEnv(token),
  });
  state.child = child;

  if (!child.pid) {
    state.child = null;
    state.exited = true;
    state.phase = "error";
    state.lastError = "cloudflared failed to start";
    throw new Error("cloudflared failed to start");
  }

  return new Promise<CloudflaredNamedTunnelStatus>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const onOutput = (source: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      if (source === "stderr") {
        const message = extractCloudflaredErrorMessage(text);
        if (message) {
          state.lastError = redactNamedTunnelText(message, token);
          if (state.phase === "starting") state.phase = "error";
        }
      }
      if (extractCloudflaredConnectionReady(text)) {
        state.phase = "running";
        state.lastError = null;
        settle(() => void getCloudflaredNamedTunnelStatus().then(resolve, reject));
      }
    };

    child.stdout?.on("data", (chunk) => onOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => onOutput("stderr", chunk));

    child.once("error", () => {
      state.exited = true;
      state.child = null;
      state.phase = "error";
      state.lastError = "cloudflared failed to start";
      settle(() => reject(new Error("cloudflared failed to start")));
    });

    child.once("exit", (code, signal) => {
      state.exited = true;
      if (state.child === child) state.child = null;
      const clean = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
      if (clean) {
        state.phase = "stopped";
        state.lastError = null;
      } else {
        state.phase = "error";
        state.lastError =
          state.lastError || `cloudflared exited unexpectedly (${code ?? signal ?? "unknown"})`;
      }
      settle(() =>
        reject(new Error(`cloudflared exited before the tunnel connected (${code ?? signal})`))
      );
    });

    timer = setTimeout(() => {
      state.phase = "error";
      state.lastError = state.lastError || "Timed out waiting for the tunnel to connect";
      void killChild(state).then(() =>
        settle(() => reject(new Error("Timed out while waiting for the Cloudflare named tunnel")))
      );
    }, runtime.startTimeoutMs);
  });
}

export async function startCloudflaredNamedTunnel(): Promise<CloudflaredNamedTunnelStatus> {
  const current = await getCloudflaredNamedTunnelStatus();
  if (current.running) return current;
  if (startPromise) return startPromise;

  startPromise = launch().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

export async function restartCloudflaredNamedTunnel(): Promise<CloudflaredNamedTunnelStatus> {
  await stopCloudflaredNamedTunnel();
  return startCloudflaredNamedTunnel();
}
