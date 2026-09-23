import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_KEEPALIVE_MS, STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { createErrorResult, sanitizePublicMessage } from "../../utils/error.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { recordSuccess } from "../../services/providerHealth.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { createUsageCostStream, resolvePricing } from "../../utils/servedHeaders.js";

// Client formats whose final usage event can carry `usage.cost`.
const COST_STREAM_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 *
 * Same-format requests normally take the raw passthrough stream (no
 * translateResponse call at all). But when OAuth tool cloaking renamed the
 * client's tools (toolNameMap present), every streamed tool_use block carries
 * the suffixed name and MUST be decloaked before reaching the client — which
 * happens in translateResponse's same-format branch. Route cloaked
 * same-format streams through the translate stream so that branch actually
 * runs; without a map, passthrough stays byte-exact as before.
 */
export function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  // Same-format streams must still decloak when the request was cloaked:
  // translateRequest() suffixes client tools for OAuth-cloaked Claude providers
  // even when no format conversion is needed (cloak runs after the same-format
  // request shortcut), so a claude→claude stream carrying a toolNameMap has to
  // go through the translate pipeline — its same-format branch applies
  // decloakStreamChunk() and otherwise relays the parsed event untouched.
  if (needsTranslation(targetFormat, sourceFormat) || toolNameMap?.size > 0) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, sourceFormat);
}

// Content types an upstream may legitimately stream, beyond SSE and JSON, keyed by the format the
// provider declares. Ollama-format providers dial the native /api/chat (see
// providers/registry/ollama-local.js) which answers application/x-ndjson on success, and
// translator/response/ollama-to-openai.js exists to convert exactly that stream, so the
// error-page guard below must not treat it as a non-SSE body (issue #3985).
const UPSTREAM_STREAM_CONTENT_TYPES = {
  [FORMATS.OLLAMA]: ['application/x-ndjson'],
};

function isStreamableUpstreamContentType(contentType, targetFormat) {
  if (contentType.includes('text/event-stream') || contentType.includes('application/json')) return true;
  return (UPSTREAM_STREAM_CONTENT_TYPES[targetFormat] || []).some(type => contentType.includes(type));
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, reconnect, provider, model, errorContext, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, decision, reqTag, log, credentials }) {
  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !isStreamableUpstreamContentType(upstreamContentType, targetFormat)) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizePublicMessage(
      sanitizedTitle || (bodyText.length < 200 ? bodyText : "Upstream returned an invalid streaming response")
    );
    const status = providerResponse.status >= 400 ? providerResponse.status : HTTP_STATUS.BAD_GATEWAY;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return createErrorResult(status, shortMsg, undefined, { ...errorContext, provider, model });
  }

  // A 200 with a JSON body on a streaming request is an error envelope often enough
  // that piping it blind would both leak it as content and mark the account healthy.
  // Read it once, fail on `error`, and hand the bytes back to the pipe otherwise.
  let streamSource = providerResponse;
  if (upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    let upstreamError = null;
    try { upstreamError = JSON.parse(bodyText)?.error; } catch {}
    if (upstreamError) {
      const shortMsg = sanitizePublicMessage(upstreamError.message || upstreamError, "Upstream returned an error instead of a stream");
      if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${HTTP_STATUS.BAD_GATEWAY} · ${provider}/${model} · JSON error on streaming request\n    ${shortMsg}`);
      streamController?.handleError?.(new Error(`upstream JSON error: ${shortMsg}`));
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, shortMsg, undefined, { ...errorContext, provider, model });
    }
    streamSource = new Response(bodyText, { status: providerResponse.status, headers: providerResponse.headers });
  }

  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event.
  // OpenAI clients get the equivalent terminal from the transform stream, which knows
  // whether a finish_reason already went out (and returns null if so).
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : (transformStream.abortTerminalBytes || null);
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect({
    providerResponse: streamSource,
    transformStream,
    streamController,
    onAbortTerminal,
    stallTimeoutMs,
    reconnect,
    // NDJSON (Ollama) clients cannot take an SSE comment line.
    keepaliveMs: sourceFormat === FORMATS.OLLAMA ? 0 : STREAM_KEEPALIVE_MS,
    onTerminate: () => transformStream.finalizeAborted?.(),
  });

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, apiKey,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    decision,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  // The cost is only known once the stream ends, so it rides in the final usage
  // event rather than a header.
  const clientBody = COST_STREAM_FORMATS.has(sourceFormat)
    ? transformedBody.pipeThrough(createUsageCostStream({
      pricing: resolvePricing(provider, model),
      currentUsage: transformStream.currentUsage,
    }))
    : transformedBody;

  return {
    success: true,
    response: new Response(clientBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, decision, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt, { aborted = false } = {}) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const toolCalls = contentObj?.toolCalls || [];
    // A tool-call-only turn carries no content. Label it accurately rather than as
    // "[Empty streaming response]", which is indistinguishable from a truncated stream.
    const safeContent = contentObj?.content
      || (toolCalls.length ? `[Tool calls: ${toolCalls.map((call) => call.name || "unknown").join(", ")}]` : "[Empty streaming response]");
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, tool_calls: toolCalls, type: "streaming" },
      pxpipe,
      decision,
      // The client disconnected (or the upstream broke) before the stream ended.
      status: aborted ? "aborted" : "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    // A stream cut short by the client says nothing about the account's speed.
    if (!aborted) recordSuccess({ provider, connectionId, model, ttftMs: latency.ttft, latencyMs: latency.total });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
