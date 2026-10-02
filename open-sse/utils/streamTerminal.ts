import { FORMATS } from "../translator/formats.ts";

export const TRAILING_USAGE_TIMEOUT_MS = 3_000;

export const INCOMPLETE_STREAM_FAILURE = {
  status: 502,
  message: "Upstream stream ended before a terminal event",
  type: "server_error",
  code: "upstream_protocol_error",
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Explicit protocol completion, independent of whether any text or usage was produced. */
export function isStreamTerminal(payload: unknown, format: string): boolean {
  const root = record(payload);
  if (format === FORMATS.OPENAI) {
    if (root.done === true) return true; // Preserve explicit [DONE] compatibility.
    return (
      Array.isArray(root.choices) &&
      root.choices.some((choice) => {
        const reason = record(choice).finish_reason;
        return typeof reason === "string" && reason.length > 0;
      })
    );
  }
  if (format === FORMATS.CLAUDE) {
    return root.type === "message_stop" || typeof record(root.delta).stop_reason === "string";
  }
  if (format === FORMATS.OPENAI_RESPONSES || format === FORMATS.CODEX) {
    return [
      "response.completed",
      "response.incomplete",
      "response.failed",
      "response.cancelled",
      "response.canceled",
    ].includes(String(root.type));
  }
  if (format === FORMATS.GEMINI || format === FORMATS.ANTIGRAVITY) {
    const response = root.candidates ? root : record(root.response);
    return (
      Array.isArray(response.candidates) &&
      response.candidates.some((candidate) => typeof record(candidate).finishReason === "string")
    );
  }
  return format === FORMATS.OLLAMA && root.done === true;
}

export function requiresStreamTerminal(format: string): boolean {
  return [
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CODEX,
    FORMATS.GEMINI,
    FORMATS.ANTIGRAVITY,
    FORMATS.OLLAMA,
  ].includes(format);
}

/** A finish for one choice must not stop other choices that are still generating. */
export function createStreamTerminalTracker(format: string, expectedChoices = 1) {
  const seen = new Set<number>();
  const finished = new Set<number>();
  const expected = Number.isInteger(expectedChoices) && expectedChoices > 0 ? expectedChoices : 1;
  return (payload: unknown): boolean => {
    const root = record(payload);
    if (root.done === true && format === FORMATS.OPENAI) return true;
    const response = root.candidates ? root : record(root.response);
    const choices = format === FORMATS.OPENAI ? root.choices : response.candidates;
    if (
      (format === FORMATS.OPENAI || format === FORMATS.GEMINI || format === FORMATS.ANTIGRAVITY) &&
      Array.isArray(choices)
    ) {
      choices.forEach((value, position) => {
        const choice = record(value);
        const index = typeof choice.index === "number" ? choice.index : position;
        seen.add(index);
        const reason = format === FORMATS.OPENAI ? choice.finish_reason : choice.finishReason;
        if (typeof reason === "string" && reason.length > 0) finished.add(index);
      });
      return finished.size >= expected && [...seen].every((index) => finished.has(index));
    }
    return isStreamTerminal(payload, format);
  };
}

/** A one-shot deadline after completion only. Heartbeats cannot extend it. */
export function createTrailingUsageDeadline(timeoutMs = TRAILING_USAGE_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    clear,
    arm(finish: () => void) {
      if (timer) return;
      const delay =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TRAILING_USAGE_TIMEOUT_MS;
      timer = setTimeout(() => {
        timer = null;
        finish();
      }, delay);
    },
  };
}

/** Transformer.cancel is not a Web Streams hook. Clean up at the actual boundaries. */
export function withStreamCleanup(
  stream: TransformStream<Uint8Array, Uint8Array>,
  cleanup: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  return {
    readable: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              cleanup();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            cleanup();
            controller.error(error);
          }
        },
        cancel(reason) {
          cleanup();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }
    ),
    writable: new WritableStream<Uint8Array>({
      start(controller) {
        // Cancelling the readable or terminating the inner transformer must
        // immediately stop an idle source pipe, even if it never writes again.
        void writer.closed.catch((error) => {
          cleanup();
          controller.error(error);
        });
      },
      async write(chunk) {
        try {
          await writer.write(chunk);
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      async close() {
        try {
          await writer.close();
        } finally {
          cleanup();
        }
      },
      abort(reason) {
        cleanup();
        return writer.abort(reason);
      },
    }),
  };
}
