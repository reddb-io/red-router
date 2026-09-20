import { HTTP_STATUS, STREAM_EMPTY_RESPONSE_MAX_RETRIES } from "../../config/runtimeConfig.js";
import { parseUpstreamError, sanitizePublicMessage } from "../../utils/error.js";
import { FORMATS } from "../../translator/formats.js";

const EXTRA_STREAM_CONTENT_TYPES = {
  [FORMATS.OLLAMA]: ["application/x-ndjson"],
};

function isStreamContentType(contentType, targetFormat) {
  if (!contentType) return true;
  if (contentType.includes("text/event-stream") || contentType.includes("application/json")) return true;
  return (EXTRA_STREAM_CONTENT_TYPES[targetFormat] || []).some((type) => contentType.includes(type));
}

function responseWithReader(response, reader, firstChunk) {
  let first = firstChunk;
  const body = new ReadableStream({
    async pull(controller) {
      if (first !== undefined) {
        controller.enqueue(first);
        first = undefined;
        return;
      }
      try {
        const { done, value } = await reader.read();
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
    try {
      const { done, value } = await reader.read();
      if (!done) return { ...result, response: responseWithReader(response, reader, value) };
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
      return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream stream ended before its first byte" } };
    }
    log?.warn?.("STREAM", `retrying empty stream ${attempt + 1}/${maxRetries} · ${provider}/${model}`);
    result = await execute();
  }

  return { ...result, error: { statusCode: HTTP_STATUS.BAD_GATEWAY, message: "Upstream stream retry exhausted" } };
}
