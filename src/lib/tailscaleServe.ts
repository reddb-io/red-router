/**
 * Tailscale Serve: expose this router to the operator's own tailnet only (private).
 *
 * Funnel (`src/lib/tailscaleTunnel.ts`) publishes to the whole internet; Serve is the same
 * mechanism without the `AllowFunnel` flag, so only devices signed in to the tailnet can reach
 * the `https://<machine>.<tailnet>.ts.net` address. Serve and Funnel share one serve config in
 * tailscaled, so this module refuses to enable Serve while Funnel is publishing the same port and
 * reports `publicExposure` instead of pretending the endpoint is private.
 *
 * Commands (exact, no shell; the `--socket` prefix is the one Funnel already computes):
 *   enable   tailscale serve --bg --https=443 http://127.0.0.1:<port>
 *   disable  tailscale serve --https=443 off        (removes only this mapping; never `reset`,
 *                                                     which would drop the operator's other
 *                                                     serve/funnel config, and never stops the
 *                                                     daemon)
 *   status   tailscale serve status --json
 *
 * Installed / logged-in detection, daemon start and login are Funnel's, reused as is.
 */

import { execFile } from "child_process";
import os from "os";
import { promisify } from "util";
import {
  extractTailscaleEnableUrl,
  getTailscaleUrlFromStatusPayload,
  startTailscaleDaemon,
  startTailscaleLogin,
  tailscaleSharedHelpers,
} from "@/lib/tailscaleTunnel";
import { getRuntimePorts } from "@/lib/runtime/ports";

const execFileAsync = promisify(execFile);

const SERVE_HTTPS_PORT = 443;
const SERVE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;

export type TailscaleServePhase =
  "unsupported" | "not_installed" | "needs_login" | "stopped" | "running" | "error";

export type TailscaleServeStatus = {
  supported: boolean;
  installed: boolean;
  loggedIn: boolean;
  daemonRunning: boolean;
  /** True only while this router is served to the tailnet AND not published by Funnel. */
  running: boolean;
  /** Funnel is publishing the same mapping, so the endpoint is reachable from the internet. */
  publicExposure: boolean;
  tunnelUrl: string | null;
  apiUrl: string | null;
  phase: TailscaleServePhase;
  platform: string;
  lastError: string | null;
};

export type TailscaleServeEnableResult =
  | { success: true; tunnelUrl: string; apiUrl: string; status: TailscaleServeStatus }
  | { success: false; needsLogin: true; authUrl: string; status: TailscaleServeStatus }
  | { success: false; funnelActive: true; status: TailscaleServeStatus }
  | { success: false; serveNotEnabled: true; enableUrl: string | null; status: TailscaleServeStatus };

export class TailscaleServeNotInstalledError extends Error {
  constructor() {
    super("Tailscale is not installed");
    this.name = "TailscaleServeNotInstalledError";
  }
}

// ── pure helpers (exported for tests) ──────────────────────────────────────────────────────────

export function getServeTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Arguments after the optional `--socket <path>` prefix. */
export function buildServeEnableArgs(port: number): string[] {
  return ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, getServeTarget(port)];
}

export function buildServeDisableArgs(): string[] {
  return ["serve", `--https=${SERVE_HTTPS_PORT}`, "off"];
}

export function buildServeStatusArgs(): string[] {
  return ["serve", "status", "--json"];
}

function normalizeProxyTarget(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^localhost\b/i, "127.0.0.1")
    .replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read a `tailscale serve status --json` document: is this router's port being served, and is
 * Funnel publishing it? `Web` maps `host:port` to handlers; `AllowFunnel` maps the same keys to
 * true when Funnel is on.
 */
export function analyzeServeConfig(
  config: unknown,
  port: number
): { serving: boolean; publicExposure: boolean } {
  const wanted = normalizeProxyTarget(getServeTarget(port));
  const web = asRecord(asRecord(config).Web);
  const allowFunnel = asRecord(asRecord(config).AllowFunnel);
  let serving = false;
  let publicExposure = false;
  for (const [hostPort, entry] of Object.entries(web)) {
    const handlers = asRecord(asRecord(entry).Handlers);
    const matches = Object.values(handlers).some((handler) => {
      const proxy = asRecord(handler).Proxy;
      return typeof proxy === "string" && normalizeProxyTarget(proxy) === wanted;
    });
    if (!matches) continue;
    serving = true;
    if (allowFunnel[hostPort] === true) publicExposure = true;
  }
  return { serving, publicExposure };
}

// ── process seam ───────────────────────────────────────────────────────────────────────────────

type RunResult = { stdout: string; stderr: string };

export type TailscaleServeRuntime = {
  resolveBinary: () => Promise<{ binaryPath: string | null }>;
  /** `["--socket", <path>]` (or nothing on Windows), the same prefix Funnel uses. */
  socketArgs: () => Promise<string[]>;
  run: (binary: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  startDaemon: (options: { sudoPassword?: string }) => Promise<unknown>;
  startLogin: (options: {
    hostname?: string;
  }) => Promise<{ alreadyLoggedIn: true } | { authUrl: string }>;
};

const defaultRuntime = (): TailscaleServeRuntime => ({
  resolveBinary: () => tailscaleSharedHelpers.resolveBinary(),
  socketArgs: () => tailscaleSharedHelpers.buildArgs(),
  run: async (binary, args, timeoutMs) => {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      windowsHide: true,
      env: tailscaleSharedHelpers.buildExecEnv(),
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  },
  startDaemon: (options) => startTailscaleDaemon(options),
  startLogin: (options) => startTailscaleLogin(options),
});

let runtime: TailscaleServeRuntime = defaultRuntime();

/** Test seam: pass overrides, or `null` to restore the real Tailscale CLI helpers. */
export function setTailscaleServeRuntime(overrides: Partial<TailscaleServeRuntime> | null): void {
  runtime = overrides ? { ...defaultRuntime(), ...overrides } : defaultRuntime();
}

let lastError: string | null = null;

async function runTailscale(
  binary: string,
  args: string[],
  timeoutMs = STATUS_TIMEOUT_MS
): Promise<RunResult> {
  const prefix = await runtime.socketArgs();
  return runtime.run(binary, [...prefix, ...args], timeoutMs);
}

async function readJson(binary: string, args: string[]): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await runTailscale(binary, args);
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isSupportedPlatform(): boolean {
  const platform = os.platform();
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

// ── status / enable / disable ──────────────────────────────────────────────────────────────────

export async function getTailscaleServeStatus(): Promise<TailscaleServeStatus> {
  const supported = isSupportedPlatform();
  const { binaryPath } = await runtime.resolveBinary();
  const port = getRuntimePorts().apiPort;

  let loggedIn = false;
  let daemonRunning = false;
  let tunnelUrl: string | null = null;
  let serving = false;
  let publicExposure = false;

  if (binaryPath) {
    const statusPayload = await readJson(binaryPath, ["status", "--json"]);
    daemonRunning = !!statusPayload;
    loggedIn = statusPayload?.BackendState === "Running";
    tunnelUrl = getTailscaleUrlFromStatusPayload(statusPayload);
    if (loggedIn) {
      const analysis = analyzeServeConfig(await readJson(binaryPath, buildServeStatusArgs()), port);
      serving = analysis.serving;
      publicExposure = analysis.publicExposure;
    }
  }

  const running = loggedIn && serving && !publicExposure && !!tunnelUrl;
  const funnelError = publicExposure
    ? "Tailscale Funnel is publishing this port, so the endpoint is public. Stop Funnel to keep it private."
    : null;

  let phase: TailscaleServePhase = "stopped";
  if (!supported) phase = "unsupported";
  else if (!binaryPath) phase = "not_installed";
  else if (running) phase = "running";
  else if (daemonRunning && !loggedIn) phase = "needs_login";
  else if (funnelError || lastError) phase = "error";

  return {
    supported,
    installed: !!binaryPath,
    loggedIn,
    daemonRunning,
    running,
    publicExposure,
    tunnelUrl: running ? tunnelUrl : null,
    apiUrl: running && tunnelUrl ? `${tunnelUrl}/v1` : null,
    phase,
    platform: os.platform(),
    lastError: running ? null : (funnelError ?? lastError),
  };
}

export async function enableTailscaleServe({
  sudoPassword,
  hostname,
}: {
  sudoPassword?: string;
  hostname?: string;
} = {}): Promise<TailscaleServeEnableResult> {
  const { binaryPath } = await runtime.resolveBinary();
  if (!binaryPath) throw new TailscaleServeNotInstalledError();
  const port = getRuntimePorts().apiPort;

  try {
    await runtime.startDaemon({ sudoPassword });

    const statusPayload = await readJson(binaryPath, ["status", "--json"]);
    if (statusPayload?.BackendState !== "Running") {
      const login = await runtime.startLogin({ hostname });
      if ("authUrl" in login) {
        lastError = null;
        return {
          success: false,
          needsLogin: true,
          authUrl: login.authUrl,
          status: await getTailscaleServeStatus(),
        };
      }
    }

    const before = analyzeServeConfig(await readJson(binaryPath, buildServeStatusArgs()), port);
    if (before.publicExposure) {
      lastError = null;
      return { success: false, funnelActive: true, status: await getTailscaleServeStatus() };
    }

    try {
      await runTailscale(binaryPath, buildServeEnableArgs(port), SERVE_TIMEOUT_MS);
    } catch (error) {
      // Serve needs HTTPS/MagicDNS enabled on the tailnet; the CLI prints an admin-console URL and
      // waits, so a timeout with that URL in its output means "not enabled yet", not a failure.
      const output = `${(error as { stdout?: unknown }).stdout ?? ""}\n${
        (error as { stderr?: unknown }).stderr ?? ""
      }`;
      const enableUrl = extractTailscaleEnableUrl(output);
      if (enableUrl || /serve is not enabled|https.*not enabled/i.test(output)) {
        lastError = null;
        return {
          success: false,
          serveNotEnabled: true,
          enableUrl,
          status: await getTailscaleServeStatus(),
        };
      }
      throw error;
    }

    const status = await getTailscaleServeStatus();
    if (!status.running || !status.tunnelUrl || !status.apiUrl) {
      throw new Error("Failed to determine the Tailscale Serve URL");
    }
    lastError = null;
    return { success: true, tunnelUrl: status.tunnelUrl, apiUrl: status.apiUrl, status };
  } catch (error) {
    // Kept for the status pill only; routes never echo it (they use a fixed message).
    lastError = "Tailscale Serve could not be enabled. Check the server log for details.";
    throw error;
  }
}

export async function disableTailscaleServe(): Promise<{
  success: true;
  status: TailscaleServeStatus;
}> {
  const { binaryPath } = await runtime.resolveBinary();
  if (binaryPath) {
    try {
      await runTailscale(binaryPath, buildServeDisableArgs(), SERVE_TIMEOUT_MS);
    } catch (error) {
      lastError = "Tailscale Serve could not be disabled. Check the server log for details.";
      throw error;
    }
  }
  lastError = null;
  return { success: true, status: await getTailscaleServeStatus() };
}
