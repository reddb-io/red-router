import { createHash } from "node:crypto";
import os from "node:os";
import {
  BaseExecutor,
  type ExecuteInput,
  type ExecutorExecuteResult,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";

const BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const SESSION_AFFINITY_PREFIX = "ses_";
const SESSION_ID_LENGTH = 24;
const JWT_FALLBACK_TTL_SEC = 3000;
const JWT_EXPIRY_BUFFER_MS = 300000;
const SESSION_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

// Anti-abuse gate: upstream rejects requests without a Chrome-like User-Agent with 403 "Illegal access"
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// Anti-abuse gate marker: the free chat endpoint returns 403 "Illegal access"
// unless a system message contains this exact MiMoCode signature substring.
export const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

// In-memory JWT cache (per-process, survives across requests but not restarts)
let cachedJwt: string | null = null;
let jwtExpiresAt = 0;

// Device fingerprint reused as the bootstrap "client" — stable per machine
function generateFingerprint(): string {
  let username = "unknown-user";
  try {
    username = os.userInfo().username;
  } catch {
    // ignore
  }
  const cpu = (os.cpus()[0]?.model || "unknown-cpu").trim();
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
  return createHash("sha256").update(seed).digest("hex");
}

function generateSessionId(): string {
  let id = SESSION_AFFINITY_PREFIX;
  for (let i = 0; i < SESSION_ID_LENGTH; i++) {
    id += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
  }
  return id;
}

// Derive expiry from the JWT exp claim; fall back to a fixed TTL when unparseable
function parseJwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64").toString()) as {
      exp?: number;
    };
    if (payload.exp) return payload.exp * 1000;
  } catch {
    // ignore
  }
  return Date.now() + JWT_FALLBACK_TTL_SEC * 1000;
}

// Ensure the body carries the anti-abuse marker in a system message (idempotent)
function injectSystemMarker(body: unknown): unknown {
  const typed = body as { messages?: unknown } | null;
  const messages = typed?.messages;
  if (!Array.isArray(messages)) return body;
  const hasMarker = messages.some(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as Record<string, unknown>).role === "system" &&
      typeof (m as Record<string, unknown>).content === "string" &&
      ((m as Record<string, unknown>).content as string).includes(MIMO_SYSTEM_MARKER)
  );
  if (hasMarker) return body;
  return { ...body, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

function resetJwtCache(): void {
  cachedJwt = null;
  jwtExpiresAt = 0;
}

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function bootstrapJwt(): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }

  const response = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": randomUserAgent(),
    },
    body: JSON.stringify({ client: generateFingerprint() }),
  });

  if (!response.ok) {
    throw new Error(`MiMo bootstrap failed: ${response.status}`);
  }

  const data = (await response.json()) as { jwt?: string };
  if (!data.jwt) {
    throw new Error("MiMo bootstrap returned no JWT");
  }

  cachedJwt = data.jwt;
  jwtExpiresAt = parseJwtExp(data.jwt);
  return cachedJwt;
}

/**
 * MimoFreeExecutor — Xiaomi MiMo Code free chat endpoint.
 *
 * Ported from the legacy fork (open-sse/executors/mimo-free.js @ c66f917c).
 * Auth is an anonymous per-process JWT from the bootstrap endpoint (device
 * fingerprint as client id), re-bootstrapped once on 401/403. The free
 * upstream itself ended of service — the provider entry is hidden until a
 * replacement channel is wired (see registry/mimo-free).
 */
export class MimoFreeExecutor extends BaseExecutor {
  private readonly sessionId: string;

  constructor() {
    const config = PROVIDERS["mimo-free"];
    super("mimo-free", {
      id: "mimo-free",
      baseUrl: config?.baseUrl || "https://api.xiaomimimo.com/api/free-ai/openai/chat",
      headers: { "Content-Type": "application/json" },
    });
    this.sessionId = generateSessionId();
  }

  buildUrl(): string {
    return this.config.baseUrl || "https://api.xiaomimimo.com/api/free-ai/openai/chat";
  }

  buildHeaders(_credentials: ProviderCredentials | null, stream = true): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Mimo-Source": "mimocode-cli-free",
      "User-Agent": randomUserAgent(),
      "x-session-affinity": this.sessionId,
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  transformRequest(model: string, body: unknown): unknown {
    void model;
    return injectSystemMarker(body);
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const { body, stream, signal, log } = input;

    let jwt: string;
    try {
      jwt = await bootstrapJwt();
    } catch (error) {
      log?.error?.(
        "AUTH",
        `MiMo bootstrap failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

    const url = this.buildUrl();
    const transformedBody = this.transformRequest(input.model, body);
    const headers = {
      ...this.buildHeaders(input.credentials, stream),
      Authorization: `Bearer ${jwt}`,
    };
    const bodyStr = JSON.stringify(transformedBody);
    log?.debug?.("FETCH", `MIMO-FREE → ${url} | body=${bodyStr.length}B`);

    this.assertOutboundUrlAllowed(url);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: signal ?? undefined,
    });

    // On auth failure, invalidate cache and retry once with a fresh JWT
    if (response.status === 401 || response.status === 403) {
      log?.debug?.("AUTH", `MiMo auth failed (${response.status}), re-bootstrapping...`);
      resetJwtCache();
      jwt = await bootstrapJwt();
      headers["Authorization"] = `Bearer ${jwt}`;
      const retryResponse = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: signal ?? undefined,
      });
      return { response: retryResponse, url, headers, transformedBody };
    }

    return { response, url, headers, transformedBody };
  }
}

export default MimoFreeExecutor;
