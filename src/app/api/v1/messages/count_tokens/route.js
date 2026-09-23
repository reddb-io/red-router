import { createErrorContext, errorResponse, withRequestId } from "open-sse/utils/error.js";
import { FORMATS } from "open-sse/translator/formats.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function countValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countValueChars(item), 0);
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce((total, [key, item]) => {
      return total + key.length + countValueChars(item);
    }, 0);
  }
  return 0;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);

  switch (block.type) {
    case "text":
      return countValueChars(block.text);
    case "tool_use":
      return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result":
      return countValueChars(block.content);
    case "thinking":
      return countValueChars(block.thinking);
    default:
      return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;

  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, block) => total + countContentBlockChars(block), 0);
  }
  return countValueChars(content);
}

export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);

  for (const msg of messages) {
    totalChars += countMessageChars(msg);
  }

  return Math.ceil(totalChars / 4);
}

const FIRST_PARTY = new Set(["claude", "anthropic"]);

/**
 * Exact count from Anthropic itself, when the model resolves to an Anthropic
 * first-party account: the same executor as chat builds the URL and headers
 * (client anthropic-beta/version passed through). Null when not applicable or on
 * any failure, so the caller falls back to the estimate.
 */
async function upstreamCount(request, body) {
  if (typeof body?.model !== "string" || !body.model) return null;
  try {
    const [{ getModelInfo }, auth, { checkAndRefreshToken }, { getExecutor }, { proxyAwareFetch }, { forwardedResponseHeaders }] = await Promise.all([
      import("@/sse/services/model.js"),
      import("@/sse/services/auth.js"),
      import("@/sse/services/tokenRefresh.js"),
      import("open-sse/executors/index.js"),
      import("open-sse/utils/proxyFetch.js"),
      import("open-sse/utils/claudeFidelity.js"),
    ]);
    const apiKey = auth.extractApiKey(request);
    // Our account answers this one: hold it to the same key rule as chat.
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    if (settings?.requireApiKey && !(apiKey && await auth.isValidApiKey(apiKey))) return null;
    const info = await getModelInfo(body.model);
    if (!FIRST_PARTY.has(info?.provider)) return null;
    const credentials = await auth.getProviderCredentials(info.provider, null, info.model, { apiKey, connectionIds: info.connectionIds });
    if (!credentials || credentials.noActiveCredentials || credentials.allRateLimited) return null;
    const creds = await checkAndRefreshToken(info.provider, credentials);
    creds.rawHeaders = Object.fromEntries(request.headers.entries());
    creds.claudeFaithful = true;
    const executor = getExecutor(info.provider);
    const url = executor.buildUrl(info.model, false, 0, creds).replace(/\/messages(\?.*)?$/, "/messages/count_tokens$1");
    const headers = executor.buildHeaders(creds, false, url, info.model);
    const psd = creds.providerSpecificData || {};
    const res = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: info.model }),
      signal: AbortSignal.timeout(15_000),
    }, {
      connectionProxyEnabled: psd.connectionProxyEnabled === true,
      connectionProxyUrl: psd.connectionProxyUrl || "",
      connectionNoProxy: psd.connectionNoProxy || "",
      vercelRelayUrl: psd.vercelRelayUrl || "",
    });
    if (!res.ok) return null;
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...forwardedResponseHeaders(res) },
    });
  } catch {
    return null;
  }
}

/**
 * POST /v1/messages/count_tokens - exact from Anthropic for first-party models,
 * else an estimate (characters / 4).
 */
export async function POST(request) {
  const errorContext = createErrorContext(request, FORMATS.CLAUDE);
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body", errorContext);
  }

  const exact = await upstreamCount(request, body);
  if (exact) return withRequestId(exact, errorContext);

  const inputTokens = estimateAnthropicInputTokens(body);

  return withRequestId(new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  }), errorContext);
}

