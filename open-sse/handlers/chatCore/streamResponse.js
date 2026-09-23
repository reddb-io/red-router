import { HTTP_STATUS, STREAM_EMPTY_RESPONSE_MAX_RETRIES, STREAM_READ_AHEAD_MAX_BYTES, STREAM_READ_AHEAD_MS } from "../../config/runtimeConfig.js";
import { parseUpstreamError, sanitizePublicMessage } from "../../utils/error.js";
import { FORMATS } from "../../translator/formats.js";
import { createStreamProbe, looksLikeSSE } from "./streamProbe.js";

const EXTRA_STREAM_CONTENT_TYPES = {
  [FORMATS.OLLAMA]: ["application/x-ndjson"],
};

function isStreamContentType(contentType, targetFormat) {
  if (!contentType) return true;
  if (contentType.includes("text/event-stream") || contentType.includes("application/json")) return true;
  return (EXTRA_STREAM_CONTENT_TYPES[targetFormat] || []).some((type) => contentType.includes(type));
}

// Replays the chunks read ahead, then a read left pending by the read-ahead
// deadline, then the rest of the upstream body.
function responseWithReader(response, reader, heldChunks, pendingRead = null) {
  const held = [...heldChunks];
  let pending = pendingRead;
  const body = new ReadableStream({
    async pull(controller) {
      if (held.length) {
        controller.enqueue(held.shift());
        return;
      }
      try {
        const read = pending || reader.read();
        pending = null;
        const { done, value } = await read;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function validateStreamingResponse(response, { executor, targetFormat }) {
  if (!response?.ok) {
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(response, executor);
    return { error: { statusCode, message, resetsAtMs } };
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!isStreamContentType(contentType, targetFormat)) {
    const bodyText = await response.text().catch(() => "");
    const title = bodyText.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
    const message = sanitizePublicMessage(
      title.replace(/<[^>]*>/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, 160)
        || (bodyText.length < 200 ? bodyText : "Upstream returned an invalid streaming response"),
    );
    return { error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message } };
  }

  if (contentType.includes("application/json")) {
    const bodyText = await response.text().catch(() => "");
    let envelope;
    try { envelope = JSON.parse(bodyText); } catch { /* handled as a normal stream body */ }
    if (envelope?.error) {
      const message = sanitizePublicMessage(
        envelope.error.message || envelope.error,
        "Upstream returned an error instead of a stream",
      );
      return { error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message } };
    }
    response = new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return { response };
}

const READ_AHEAD_TIMEOUT = Symbol("read-ahead timeout");

function readWithin(read, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(READ_AHEAD_TIMEOUT), ms); });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read an SSE body until its first event that answers something. Returns the
 * chunks read (to replay), and a verdict: "answer" (release), "error" (an in-band
 * failure) or "empty" (EOF before any answer). Non-SSE bodies, the byte cap and
 * the deadline all release the stream as is.
 */
async function readAhead(reader, firstChunk, { readAheadMs, maxBytes, signal }) {
  const chunks = [firstChunk];
  const decoder = new TextDecoder();
  const textOf = (chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  const firstText = textOf(firstChunk);
  if (!looksLikeSSE(firstText)) return { kind: "answer", chunks };
  const probe = createStreamProbe();
  let verdict = probe.push(firstText);
  let bytes = firstChunk.byteLength ?? firstChunk.length ?? 0;
  const deadline = Date.now() + readAheadMs;
  while (verdict.kind === "pending") {
    const remaining = deadline - Date.now();
    if (bytes > maxBytes || remaining <= 0) return { kind: "answer", chunks };
    const read = reader.read();
    const result = await readWithin(read, remaining);
    if (result === READ_AHEAD_TIMEOUT) return { kind: "answer", chunks, pendingRead: read };
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (result.done) return { kind: "empty", chunks };
    chunks.push(result.value);
    bytes += result.value?.byteLength ?? result.value?.length ?? 0;
    verdict = probe.push(textOf(result.value));
  }
  return { ...verdict, chunks };
}

/**
 * Validate a streaming response and acquire its first byte before callers
 * commit status/headers. Empty/read-failed bodies are retried; HTTP and JSON
 * error responses are terminal and retain their status metadata.
 */
export async function prepareStreamingResponse({
  initialResult,
  execute,
  executor,
  targetFormat,
  signal,
  maxRetries = STREAM_EMPTY_RESPONSE_MAX_RETRIES,
  readAheadMs = STREAM_READ_AHEAD_MS,
  maxReadAheadBytes = STREAM_READ_AHEAD_MAX_BYTES,
  log,
  provider,
  model,
}) {
  let result = initialResult;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");

    const validated = await validateStreamingResponse(result.response, { executor, targetFormat });
    if (validated.error) return { ...result, error: validated.error };

    const response = validated.response;
    if (!response.body) {
      return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream streaming response had no body" } };
    }

    const reader = response.body.getReader();
    let emptyMessage = "Upstream stream ended before its first byte";
    try {
      const { done, value } = await reader.read();
      if (!done) {
        const ahead = await readAhead(reader, value, { readAheadMs, maxBytes: maxReadAheadBytes, signal });
        if (ahead.kind === "answer") return { ...result, response: responseWithReader(response, reader, ahead.chunks, ahead.pendingRead) };
        if (ahead.kind === "error") {
          await reader.cancel("in-band upstream error").catch(() => {});
          log?.warn?.("STREAM", `in-band error before any answer · ${provider}/${model} · ${ahead.statusCode} ${ahead.message}`);
          return { ...result, error: { statusCode: ahead.statusCode, message: ahead.message } };
        }
        // EOF after only preamble events (role chunk, choices:null, message_start):
        // the same transient failure as an empty body.
        emptyMessage = "Upstream stream ended without any content";
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      if (attempt >= maxRetries) {
        return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream stream failed before its first byte" } };
      }
      log?.warn?.("STREAM", `retrying stream before first byte ${attempt + 1}/${maxRetries} · ${provider}/${model}`);
      result = await execute();
      continue;
    }

    await reader.cancel("empty upstream stream").catch(() => {});
    if (attempt >= maxRetries) {
      return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: emptyMessage } };
    }
    log?.warn?.("STREAM", `retrying empty stream ${attempt + 1}/${maxRetries} · ${provider}/${model}`);
    result = await execute();
  }

  return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream stream retry exhausted" } };
}
