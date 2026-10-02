import { awaitWithAbort } from "@/shared/utils/awaitWithAbort";

// Health probes request a short answer. Never retain an unbounded response or heartbeat history.
export const MODEL_TEST_BODY_MAX_BYTES = 1_048_576;

/** Stop on an explicit SSE completion, EOF or cancellation, independently of HTTP socket closure. */
export async function readModelTestBody(
  response: Response,
  streaming: boolean,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let pending = "";
  let eventData: string[] = [];
  let ended = false;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!ended) {
      const result = signal
        ? await awaitWithAbort(() => reader.read(), signal)
        : await reader.read();
      if (result.done) {
        text += decoder.decode();
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > MODEL_TEST_BODY_MAX_BYTES)
        throw new Error("Model test response exceeded the diagnostic size limit.");
      const chunk = decoder.decode(result.value, { stream: true });
      text += chunk;
      if (!streaming) continue;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line === "") {
          if (eventData.join("\n").trim() === "[DONE]") {
            ended = true;
            break;
          }
          eventData = [];
        } else if (line.startsWith("data:")) {
          eventData.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    signal?.throwIfAborted();
    return text;
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Do not wait for a broken upstream's cancel hook before returning a diagnostic.
    cancel();
    reader.releaseLock();
  }
}
