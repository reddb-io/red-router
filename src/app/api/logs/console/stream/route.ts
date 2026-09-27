import { NextRequest } from "next/server";
import { z } from "zod";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { ConsoleLogTail } from "@/lib/consoleLogTail";
import { getAppLogFilePath } from "@/lib/logEnv";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  level: z.enum(["all", "trace", "debug", "info", "warn", "error", "fatal"]).default("all"),
  component: z.string().max(128).default(""),
});

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const query = querySchema.safeParse({
    level: request.nextUrl.searchParams.get("level") ?? undefined,
    component: request.nextUrl.searchParams.get("component") ?? undefined,
  });
  if (!query.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid console log stream filter",
      type: "invalid_request",
    });
  }

  const tail = new ConsoleLogTail(getAppLogFilePath(), query.data, 500);
  const encoder = new TextEncoder();
  let closed = false;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
    request.signal.removeEventListener("abort", onAbort);
  };

  const send = (payload: unknown) => {
    if (closed || !controller) return;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const onAbort = () => {
    cleanup();
    try {
      controller?.close();
    } catch {
      // The reader may have already cancelled the stream.
    }
  };

  const sync = async () => {
    if (closed || inFlight || (controller?.desiredSize ?? 0) <= 0) return;
    inFlight = true;
    try {
      const update = await tail.poll();
      if (update) send(update);
    } catch (error) {
      try {
        send({
          type: "error",
          message: sanitizeErrorMessage(error) || "Unable to read console logs",
        });
      } catch {
        // A disconnected reader cannot receive the error event; cleanup below.
      } finally {
        cleanup();
        try {
          controller?.close();
        } catch {
          // The connection was already closed while handling the error.
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      void sync();
      pollTimer = setInterval(() => void sync(), 1_000);
      pingTimer = setInterval(() => {
        if (closed || !controller || (controller.desiredSize ?? 0) <= 0) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          onAbort();
        }
      }, 25_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
