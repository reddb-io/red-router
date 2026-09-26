import { z } from "zod";

import { buildErrorBody } from "../utils/error.ts";

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const ENCODER = new TextEncoder();
const EnvelopeSchema = z
  .object({
    statusCodeValue: z.union([z.number(), z.string()]).optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

type JsonRecord = Record<string, unknown>;
type StreamEvent =
  | { kind: "ignore" }
  | { kind: "done" }
  | { kind: "error"; status: number; message: string }
  | { kind: "chunk"; value: JsonRecord };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function quotaBlock(body: unknown): boolean {
  if (typeof body === "string" && body.includes("pricingUrl")) return true;
  try {
    const value = typeof body === "string" ? JSON.parse(body) : body;
    const data = record(value);
    return data?.pricingUrl !== undefined || ["110", "112", "10605"].includes(String(data?.code));
  } catch {
    return false;
  }
}

function parseLine(line: string): StreamEvent {
  if (ENCODER.encode(line).byteLength > MAX_LINE_BYTES) {
    return { kind: "error", status: 502, message: "Qoder CN SSE line exceeds limit" };
  }
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return { kind: "ignore" };
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { kind: "done" };

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "error", status: 502, message: "Qoder CN sent malformed SSE JSON" };
  }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "error", status: 502, message: "Qoder CN sent an invalid SSE envelope" };
  }

  const rawStatus = parsed.data.statusCodeValue;
  const status = rawStatus === undefined ? 200 : Number(rawStatus);
  const validStatus = Number.isInteger(status) && status >= 400 && status <= 599;
  if (status !== 200) {
    const isQuota = quotaBlock(parsed.data.body);
    return {
      kind: "error",
      status: isQuota ? 403 : validStatus ? status : 502,
      message: isQuota
        ? "Qoder CN quota is unavailable"
        : validStatus
          ? `Qoder CN upstream status ${status}`
          : "Qoder CN sent an invalid upstream status",
    };
  }

  if (parsed.data.body === "[DONE]") return { kind: "done" };
  let inner: unknown = parsed.data.body;
  if (inner == null || inner === "") return { kind: "ignore" };
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return { kind: "error", status: 502, message: "Qoder CN sent malformed chat data" };
    }
  }
  const chunk = record(inner);
  if (!chunk) return { kind: "error", status: 502, message: "Qoder CN sent invalid chat data" };
  if (chunk.error !== undefined) {
    return { kind: "error", status: 502, message: "Qoder CN sent a chat error" };
  }
  return { kind: "chunk", value: chunk };
}

export function canonicalizeQoderCnUsage(raw: unknown): JsonRecord | null {
  const usage = record(raw);
  if (!usage) return null;
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = number(usage.completion_tokens ?? usage.output_tokens);
  if (prompt === null && completion === null) return null;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const result: JsonRecord = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: number(usage.total_tokens) ?? promptTokens + completionTokens,
  };
  const details = record(usage.prompt_tokens_details);
  const cached = number(
    details?.cached_tokens ??
      usage.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens
  );
  const creation = number(details?.cache_creation_tokens ?? usage.cache_creation_input_tokens);
  if (cached !== null || creation !== null) {
    result.prompt_tokens_details = {
      ...(cached !== null ? { cached_tokens: cached } : {}),
      ...(creation !== null ? { cache_creation_tokens: creation } : {}),
    };
    if (cached !== null) result.cached_tokens = cached;
  }
  const completionDetails = record(usage.completion_tokens_details);
  const reasoning = number(usage.reasoning_tokens ?? completionDetails?.reasoning_tokens);
  if (reasoning !== null) {
    result.reasoning_tokens = reasoning;
    result.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return result;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify(buildErrorBody(status, message)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Convert Qoder's envelope SSE to OpenAI SSE, preserving late usage and errors. */
export async function wrapQoderCnSse(upstream: Response, model: string): Promise<Response> {
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    return errorResponse(upstream.status, `Qoder CN returned HTTP ${upstream.status}`);
  }
  if (!upstream.body) return errorResponse(502, "Qoder CN returned an empty stream");

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let drained = false;
  try {
    // Wait for the first data line before committing the downstream status.
    while (true) {
      const lines = buffer.split("\n");
      for (let index = 0; index < lines.length - 1; index++) {
        const event = parseLine(lines[index]);
        if (event.kind === "error") {
          await reader.cancel("Qoder CN first-frame error").catch(() => {});
          reader.releaseLock();
          return errorResponse(event.status, event.message);
        }
        if (event.kind === "chunk" || event.kind === "done") break;
      }
      if (lines.slice(0, -1).some((line) => parseLine(line).kind !== "ignore")) break;
      if (ENCODER.encode(buffer).byteLength > MAX_LINE_BYTES || totalBytes > MAX_STREAM_BYTES) {
        throw new Error("Qoder CN first SSE frame exceeds limit");
      }
      const next = await reader.read();
      if (next.done) {
        drained = true;
        buffer += decoder.decode();
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) throw new Error("Qoder CN SSE response exceeds limit");
      buffer += decoder.decode(next.value, { stream: true });
    }
    if (drained) {
      let found = false;
      for (const line of buffer.split("\n")) {
        const event = parseLine(line);
        if (event.kind === "ignore") continue;
        if (event.kind === "error") {
          await reader.cancel("Qoder CN first-frame error").catch(() => {});
          reader.releaseLock();
          return errorResponse(event.status, event.message);
        }
        found = true;
        break;
      }
      if (!found) throw new Error("Qoder CN first SSE frame is empty");
    }
  } catch {
    await reader.cancel("Qoder CN first-frame parse failed").catch(() => {});
    reader.releaseLock();
    return errorResponse(502, "Qoder CN first SSE frame failed");
  }

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let complete = false;
      let finish: string | null = null;
      let usage: JsonRecord | null = null;
      let id = `qoder-cn-${Date.now()}`;
      let created = Math.floor(Date.now() / 1000);
      let outputModel = model;
      const emit = (value: unknown) => {
        if (!cancelled) controller.enqueue(ENCODER.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      const emitTerminal = () => {
        emit({
          id,
          object: "chat.completion.chunk",
          created,
          model: outputModel,
          choices: [{ index: 0, delta: {}, finish_reason: finish || "stop" }],
          ...(usage ? { usage } : {}),
        });
        if (!cancelled) controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
        complete = true;
      };
      const handleLine = (line: string) => {
        const event = parseLine(line);
        if (event.kind === "ignore") return;
        if (event.kind === "done") {
          emitTerminal();
          return;
        }
        if (event.kind === "error") {
          emit(buildErrorBody(event.status, event.message));
          if (!cancelled) controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
          complete = true;
          return;
        }
        const chunk = event.value;
        if (typeof chunk.id === "string" && chunk.id) id = chunk.id;
        if (typeof chunk.created === "number") created = chunk.created;
        if (typeof chunk.model === "string" && chunk.model) outputModel = chunk.model;
        const nextUsage = canonicalizeQoderCnUsage(chunk.usage);
        if (nextUsage) usage = nextUsage;
        const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : null;
        const delta = record(choice?.delta);
        const reason = choice?.finish_reason ?? delta?.finish_reason ?? chunk.finish_reason;
        if (typeof reason === "string" && reason) finish = reason;
        const usefulDelta = delta && Object.keys(delta).some((key) => key !== "finish_reason");
        if (usefulDelta) {
          const { finish_reason: _finishReason, ...forwardDelta } = delta;
          emit({
            ...chunk,
            model: outputModel,
            choices: [{ ...choice, delta: forwardDelta, finish_reason: null }],
            usage: undefined,
          });
        }
        if (finish && usage) emitTerminal();
      };
      const consume = (final = false) => {
        let newline: number;
        while (!complete && (newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
        if (final && !complete && buffer.trim()) {
          handleLine(buffer);
          buffer = "";
        }
      };

      try {
        consume(drained);
        while (!complete && !drained && !cancelled) {
          const next = await reader.read();
          if (next.done) {
            drained = true;
            buffer += decoder.decode();
            consume(true);
            break;
          }
          totalBytes += next.value.byteLength;
          if (totalBytes > MAX_STREAM_BYTES) throw new Error("Qoder CN SSE response exceeds limit");
          buffer += decoder.decode(next.value, { stream: true });
          consume();
          if (ENCODER.encode(buffer).byteLength > MAX_LINE_BYTES) {
            throw new Error("Qoder CN SSE line exceeds limit");
          }
        }
        if (!complete && !cancelled) {
          if (finish) emitTerminal();
          else throw new Error("Qoder CN stream ended before completion");
        }
      } catch {
        if (!cancelled) {
          emit(buildErrorBody(502, "Qoder CN SSE stream failed"));
          controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
        }
      } finally {
        await reader.cancel("Qoder CN stream finished").catch(() => {});
        reader.releaseLock();
        if (!cancelled) controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
