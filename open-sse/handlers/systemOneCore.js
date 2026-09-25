import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  SYSTEM_ONE_DEFAULT_MODEL,
  SYSTEM_ONE_MODEL_PREFIXES,
  SYSTEM_ONE_PROVIDER_ID,
  SYSTEM_ONE_PROVIDER_IDS,
} from "../config/systemOne.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { PROVIDER_ID_TO_ALIAS, getModelType } from "../config/providerModels.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { errorResponse, resetsAtFromHeaders, sanitizePublicMessage } from "../utils/error.js";

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

function jsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function normalizeSystemOneModel(value) {
  if (value === undefined || value === null || value === "") return SYSTEM_ONE_DEFAULT_MODEL;
  if (typeof value !== "string") return null;

  let model = value.trim();
  for (const prefix of SYSTEM_ONE_MODEL_PREFIXES) {
    if (model.startsWith(prefix)) {
      model = model.slice(prefix.length);
      break;
    }
  }

  if (model === "jev" || model === "typesafe-ai/jev") return SYSTEM_ONE_DEFAULT_MODEL;

  return /^jev-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) ? model : null;
}

export function getSystemOneProviderOrder(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  const explicitProvider = requested.startsWith("vercel-ai-gateway/") || requested.startsWith("vercel/")
    ? "vercel-ai-gateway"
    : requested.startsWith("openrouter/")
      ? "openrouter"
      : requested.startsWith("opencode-zen/") || requested.startsWith("ocz/")
        ? "opencode-zen"
        : null;
  if (!explicitProvider) {
    return [...SYSTEM_ONE_PROVIDER_IDS];
  }
  // An explicitly qualified model belongs to that gateway. Keep native TypeSafe
  // as the only fallback instead of silently switching between resellers.
  return [explicitProvider, SYSTEM_ONE_PROVIDER_ID];
}

export function validateSystemOneRequest(body) {
  if (!jsonObject(body)) return "Request body must be a JSON object";
  if (!Object.hasOwn(body, "state")) return "Missing required field: state";
  const stateType = typeof body.state;
  if (body.state === null || (stateType !== "string" && !jsonObject(body.state) && !Array.isArray(body.state))) {
    return "state must be a string, object, or array";
  }
  if (!jsonObject(body.questions) || Object.keys(body.questions).length === 0) {
    return "questions must be a non-empty object";
  }
  if (!normalizeSystemOneModel(body.model)) return "Invalid JEV model";
  return null;
}

function copyResponseHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of source.entries()) {
    if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id, request-id");
  return headers;
}

async function responseMetadata(response, providerId) {
  let payload = null;
  let error = `${providerId} returned ${response.status}`;
  try {
    payload = await response.clone().json();
    error = payload?.error?.message || payload?.message || error;
  } catch {
    try {
      const text = await response.clone().text();
      if (text) error = text;
    } catch {}
  }

  return {
    usage: response.ok && jsonObject(payload?.usage) ? payload.usage : null,
    error: sanitizePublicMessage(error, `${providerId} returned ${response.status}`),
  };
}

export function resolveSystemOneProviderModel(providerId, model) {
  const normalized = normalizeSystemOneModel(model);
  if (!normalized) return null;
  const media = PROVIDER_MEDIA[providerId];
  const config = media?.systemOneConfig;
  if (!config?.baseUrl) return null;
  // The requested model wins when the provider can serve it; defaultModel only
  // covers requests this provider has no mapping or passthrough for.
  const mapped = config.modelMap?.[normalized];
  if (mapped) return mapped;
  // A System One model the provider lists (built in, or found in its live catalog,
  // e.g. OpenCode Zen's jev-1.13 next to jev-1.13-free) is served as asked.
  if (getModelType(PROVIDER_ID_TO_ALIAS[providerId] || providerId, normalized) === "systemone") return normalized;
  if (config.passthroughModels) return normalized;
  if (config.defaultModel) return config.defaultModel;
  return config.modelMap ? null : normalized;
}

/**
 * Proxy one native System One request. No chat translation is
 * involved: state/questions and provider response shapes stay intact.
 */
export async function handleSystemOneCore({
  body,
  credentials,
  providerId = SYSTEM_ONE_PROVIDER_ID,
  signal,
  proxyOptions = null,
  fetchImpl = proxyAwareFetch,
}) {
  const validationError = validateSystemOneRequest(body);
  if (validationError) {
    return {
      success: false,
      status: 400,
      error: validationError,
      response: errorResponse(400, validationError),
    };
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    const message = `No credentials for provider: ${providerId}`;
    return { success: false, status: 401, error: message, response: errorResponse(401, message) };
  }

  const media = PROVIDER_MEDIA[providerId];
  const config = media?.systemOneConfig;
  if (!config?.baseUrl) {
    const message = `System One endpoint is not configured for provider: ${providerId}`;
    return { success: false, status: 500, error: message, response: errorResponse(500, message) };
  }

  const providerModel = resolveSystemOneProviderModel(providerId, body.model);
  if (!providerModel) {
    const message = `JEV model is not available through provider: ${providerId}`;
    return { success: false, status: 422, error: message, response: errorResponse(422, message) };
  }

  const upstreamBody = { ...body, model: providerModel };
  const connectController = new AbortController();
  const timer = setTimeout(
    () => connectController.abort(new Error("fetch connect timeout")),
    config.timeoutMs || FETCH_CONNECT_TIMEOUT_MS,
  );
  const mergedSignal = signal
    ? AbortSignal.any([signal, connectController.signal])
    : connectController.signal;

  try {
    const upstream = await fetchImpl(config.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(config.headers || {}),
      },
      body: JSON.stringify(upstreamBody),
      signal: mergedSignal,
    }, proxyOptions);
    clearTimeout(timer);

    const { usage, error } = await responseMetadata(upstream, providerId);
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers),
    });

    return {
      success: upstream.ok,
      status: upstream.status,
      error,
      usage,
      resetsAtMs: resetsAtFromHeaders(upstream),
      response,
    };
  } catch (cause) {
    clearTimeout(timer);
    if (signal?.aborted && cause?.name === "AbortError") throw cause;
    const fallbackMessage = `${providerId} System One request failed`;
    const message = sanitizePublicMessage(cause?.message, fallbackMessage);
    return {
      success: false,
      status: 502,
      error: message,
      response: errorResponse(502, fallbackMessage),
    };
  }
}
