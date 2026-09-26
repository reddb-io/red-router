import { REGISTRY } from "../config/providers/index.ts";
import { JEV_DEFAULT_MODEL } from "../config/jev.ts";
import { buildErrorBody } from "../utils/error.ts";
import {
  forwardOpencodeClientHeaders,
  resolveOpencodeCliDefaults,
} from "../utils/opencodeHeaders.ts";

export type SystemOneRequest = {
  model?: string;
  state: unknown;
  questions: Record<string, unknown>;
  [key: string]: unknown;
};

export type SystemOneTarget = {
  provider: "typesafe-ai" | "opencode" | "opencode-zen" | "openrouter";
  model: string;
  url: string;
  headers: Record<string, string>;
};

const TARGET_PROVIDERS = ["typesafe-ai", "opencode", "opencode-zen", "openrouter"] as const;
const RESPONSE_HEADERS = ["retry-after", "x-request-id", "request-id"] as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty System One response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("System One response too large");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    await reader.cancel("Invalid System One response").catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Evaluation models are selected separately from the chat model catalog. */
export function resolveSystemOneTarget(requestedModel?: string): SystemOneTarget | null {
  const requested = requestedModel?.trim() || JEV_DEFAULT_MODEL;
  let provider: SystemOneTarget["provider"] = "typesafe-ai";
  let model = requested;
  if (requested.startsWith("opencode-zen/")) {
    provider = "opencode-zen";
    model = requested.slice("opencode-zen/".length);
  } else if (requested.startsWith("opencode/")) {
    provider = "opencode";
    model = requested.slice("opencode/".length);
  } else if (requested.startsWith("openrouter/")) {
    provider = "openrouter";
    model = requested.slice("openrouter/".length);
  } else if (requested.startsWith("typesafe-ai/")) {
    model = requested.slice("typesafe-ai/".length);
  } else if (requested === "jev-1.13-free") {
    provider = "opencode";
  } else if (requested === "jev") {
    model = JEV_DEFAULT_MODEL;
  }
  if (!TARGET_PROVIDERS.includes(provider)) return null;
  const config = REGISTRY[provider]?.systemOneConfig;
  if (!config) return null;
  if (provider === "openrouter") {
    if (model !== "typesafe/jev-1.13" && !Object.hasOwn(config.modelMap ?? {}, model)) {
      return null;
    }
  } else if (provider === "opencode") {
    if (model !== "jev-1.13-free" && model !== "jev-latest") return null;
  } else if (!/^jev-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    return null;
  }
  if (config.modelMap?.[model]) model = config.modelMap[model];
  return { provider, model, url: config.baseUrl, headers: config.headers ?? {} };
}

export function systemOneResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/** Keep upstream status/retry hints but never expose raw upstream error text. */
export async function forwardSystemOne(
  target: SystemOneTarget,
  token: string | null,
  body: SystemOneRequest,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ response: Response; usage: Record<string, unknown> | null }> {
  if (!token && target.provider !== "opencode") {
    return {
      response: new Response(
        JSON.stringify(buildErrorBody(401, "System One credential required")),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        }
      ),
      usage: null,
    };
  }
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 15_000, 30_000));
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let upstream: Response;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...target.headers,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (target.provider === "opencode" || target.provider === "opencode-zen") {
      forwardOpencodeClientHeaders(
        headers,
        {},
        {
          cliDefaults: resolveOpencodeCliDefaults(target.provider, true),
        }
      );
    }
    upstream = await (options.fetchImpl ?? fetch)(target.url, {
      method: "POST",
      headers,
      // System One is a native decision protocol. Preserve upstream extension
      // fields and question shapes; only the resolved model is authoritative.
      body: JSON.stringify({ ...body, model: target.model }),
      signal,
    });
  } catch {
    return {
      response: new Response(
        JSON.stringify(buildErrorBody(502, "System One upstream unavailable")),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        }
      ),
      usage: null,
    };
  }

  const headers = systemOneResponseHeaders(upstream);
  if (!upstream.ok) {
    return {
      response: new Response(
        JSON.stringify(buildErrorBody(upstream.status, "System One upstream rejected the request")),
        { status: upstream.status, headers }
      ),
      usage: null,
    };
  }
  let payload: unknown;
  try {
    payload = await readBoundedResponseJson(upstream);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      response: new Response(JSON.stringify(buildErrorBody(502, "Invalid System One response")), {
        status: 502,
        headers,
      }),
      usage: null,
    };
  }
  const result = payload as Record<string, unknown>;
  if (!result.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) {
    return {
      response: new Response(JSON.stringify(buildErrorBody(502, "Invalid System One answers")), {
        status: 502,
        headers,
      }),
      usage: null,
    };
  }
  return {
    response: new Response(JSON.stringify(result), { status: upstream.status, headers }),
    usage:
      result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
        ? (result.usage as Record<string, unknown>)
        : null,
  };
}
