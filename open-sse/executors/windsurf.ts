import { randomUUID } from "node:crypto";

import { PROVIDERS } from "../config/constants.ts";
import { resolveWindsurfModelUid } from "../config/windsurfModels.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { BaseExecutor, mergeUpstreamExtraHeaders, type ExecuteInput } from "./base.ts";
import {
  encodeWindsurfChatRequest,
  frameWindsurfRequest,
  WindsurfFrameDecoder,
  type WindsurfWireMessage,
} from "./windsurfWire.ts";

const CHAT_URL =
  "https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage";
const IDE_VERSION = "3.14.0";
const TEXT_ENCODER = new TextEncoder();
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify(buildErrorBody(status, message)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function convertMessages(body: unknown): WindsurfWireMessage[] | null {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) return null;
  if (body.tools !== undefined || body.tool_choice !== undefined) return null;
  const result: WindsurfWireMessage[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== "string") return null;
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) return null;
    let content: string;
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null;
        parts.push(part.text);
      }
      content = parts.join("");
    } else {
      return null;
    }
    if (message.tool_calls !== undefined || message.function_call !== undefined) return null;
    result.push({
      role: message.role,
      content,
      ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {}),
    });
  }
  return result;
}

export class WindsurfExecutor extends BaseExecutor {
  constructor() {
    super("windsurf", PROVIDERS.windsurf);
  }

  transformRequest(): unknown {
    return null;
  }

  async execute({ model, body, credentials, signal, upstreamExtraHeaders }: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: null;
  }> {
    const apiKey = credentials.apiKey || credentials.accessToken || "";
    const headers: Record<string, string> = {
      "Content-Type": "application/grpc-web+proto",
      Accept: "application/grpc-web+proto",
      "X-Grpc-Web": "1",
      "User-Agent": `windsurf/${IDE_VERSION}`,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
    const result = (response: Response) => ({
      response,
      url: CHAT_URL,
      headers,
      transformedBody: null as null,
    });
    if (!apiKey) return result(errorResponse(401, "Windsurf API key is required"));
    const modelUid = resolveWindsurfModelUid(model);
    if (!modelUid) return result(errorResponse(400, "Unknown Windsurf model"));
    const messages = convertMessages(body);
    if (!messages) {
      return result(errorResponse(400, "Windsurf accepts text-only chat without tools"));
    }

    let framed: Uint8Array;
    try {
      framed = frameWindsurfRequest(
        encodeWindsurfChatRequest({
          apiKey,
          modelUid,
          messages,
          sessionId: randomUUID(),
          cascadeId: randomUUID(),
          ideVersion: IDE_VERSION,
        })
      );
    } catch {
      return result(errorResponse(413, "Windsurf request exceeds the size limit"));
    }

    let upstream: Response;
    try {
      const timeout = AbortSignal.timeout(120_000);
      upstream = await fetch(CHAT_URL, {
        method: "POST",
        headers,
        body: Uint8Array.from(framed).buffer,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const safe = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      return result(
        errorResponse(signal?.aborted ? 499 : 502, `Windsurf connection failed: ${safe}`)
      );
    }
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return result(errorResponse(upstream.status, `Windsurf returned HTTP ${upstream.status}`));
    }
    return result(this.transformToSSE(upstream, model));
  }

  private transformToSSE(upstream: Response, model: string): Response {
    const id = `chatcmpl-windsurf-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (body: unknown) => {
          if (!cancelled)
            controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(body)}\n\n`));
        };
        const emitChunk = (delta: Record<string, unknown>, reason: string | null = null) => {
          emit({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: reason }],
          });
        };
        let roleEmitted = false;
        let trailerSeen = false;
        let promptTokens = 0;
        let completionTokens = 0;
        let responseBytes = 0;
        const frames = new WindsurfFrameDecoder();
        try {
          reader = upstream.body?.getReader() ?? null;
          if (!reader) throw new Error("Windsurf returned an empty body");
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            responseBytes += value.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("Windsurf response too large");
            for (const frame of frames.push(value)) {
              if (trailerSeen) throw new Error("Windsurf sent data after the trailer");
              if (frame.kind === "content") {
                if (!roleEmitted) {
                  emitChunk({ role: "assistant", content: "" });
                  roleEmitted = true;
                }
                if (frame.text) emitChunk({ content: frame.text });
              } else if (frame.kind === "done") {
                promptTokens = frame.promptTokens;
                completionTokens = frame.completionTokens;
              } else if (frame.kind === "trailer") {
                trailerSeen = true;
                if (frame.status !== 0) {
                  throw new Error(`Windsurf gRPC status ${frame.status}: ${frame.message}`);
                }
              } else if (frame.kind === "error") {
                throw new Error(frame.message);
              } else {
                throw new Error("Windsurf tool-call chunks are not supported");
              }
            }
          }
          frames.finish();
          if (!trailerSeen) throw new Error("Windsurf stream ended without a gRPC trailer");
          emit({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          });
          if (!cancelled) controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
        } catch (error) {
          try {
            await reader?.cancel("Windsurf stream failed");
          } catch {
            // Preserve the original stream/decode error.
          }
          emit(buildErrorBody(502, error instanceof Error ? error.message : String(error)));
          if (!cancelled) controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
        } finally {
          reader?.releaseLock();
          reader = null;
          if (!cancelled) controller.close();
        }
      },
      async cancel(reason) {
        cancelled = true;
        await reader?.cancel(reason);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }
}
