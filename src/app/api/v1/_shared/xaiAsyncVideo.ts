import { createHash } from "node:crypto";
import { z } from "zod";

import {
  clearRecoveredProviderState,
  extractApiKey,
  getProviderCredentialsWithQuotaPreflight,
} from "@/sse/services/auth";
import { isAllRateLimitedCredentials, rateLimitedProviderResponse } from "./rateLimit";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { CORS_HEADERS } from "@/shared/utils/cors";
import { getVideoProvider } from "@omniroute/open-sse/config/videoRegistry.ts";
import { buildErrorBody, errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  getVideoJob,
  getVideoJobByIdempotency,
  getVideoJobByUpstreamId,
  markVideoJobFailed,
  markVideoJobSubmitted,
  markVideoJobUncertain,
  reserveVideoJob,
  type VideoJob,
  type VideoJobAction,
} from "@/lib/db/videoJobs";

const CREATE_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = 64 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY = 256;
const jobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const multipartContentTypeSchema = z.string().regex(/^multipart\/form-data;.*\bboundary=[^;\s]+/i);
const createSchema = z
  .object({
    model: z.enum(["xai/grok-imagine-video", "grok-imagine-video"]).optional(),
    prompt: z.string().max(100_000).optional(),
    image: z.string().max(1_000_000).optional(),
    duration: z.number().positive().finite().optional(),
    aspect_ratio: z.string().max(32).optional(),
    resolution: z.string().max(32).optional(),
    video_id: z.string().min(1).max(512).optional(),
  })
  .passthrough();

type VideoCredential = {
  connectionId?: string;
  apiKey?: string | null;
  accessToken?: string | null;
  allExpired?: boolean;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function failed(status: number, message: string): Response {
  const response = errorResponse(status, message);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function owner(request: Request): string {
  return extractApiKey(request) || "anonymous-dashboard-or-open-api";
}

function accepted(job: VideoJob): Response {
  const response = json(
    {
      request_id: job.upstreamRequestId || job.id,
      job_id: job.id,
      status: job.state === "submitted" ? "pending" : job.state,
      object: "video",
    },
    202
  );
  response.headers.set("x-9router-connection-id", job.connectionId);
  response.headers.set("x-omniroute-connection-id", job.connectionId);
  response.headers.set(
    "Access-Control-Expose-Headers",
    "x-9router-connection-id, x-omniroute-connection-id"
  );
  return response;
}

async function readJsonBody(request: Request): Promise<{ raw: string; parsed: unknown }> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("too_large");
  const bytes = await readBoundedBytes(request, MAX_BODY_BYTES);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { raw, parsed: JSON.parse(raw) as unknown };
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("too_large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Async xAI submission. Reservations are durable before the billable POST; an
 * ambiguous timeout or 5xx is never retried under the same idempotency key.
 */
export async function createXaiAsyncVideo(
  request: Request,
  action: VideoJobAction
): Promise<Response> {
  const auth = await enforceClientApiRouteAuth(request);
  if (auth) return auth;

  const contentType = request.headers.get("content-type") || "";
  const isJson = /^application\/json(?:;|$)/i.test(contentType);
  const isMultipart = multipartContentTypeSchema.safeParse(contentType).success;
  if (!isJson && !isMultipart) return failed(415, "Unsupported video content type");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && (!idempotencyKey.trim() || idempotencyKey.length > MAX_IDEMPOTENCY_KEY)) {
    return failed(400, "Invalid Idempotency-Key");
  }

  let forwardBody: string | Uint8Array;
  let sourceVideoId: string | null = null;
  try {
    if (isJson) {
      const { raw, parsed: input } = await readJsonBody(request);
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return failed(400, "Invalid video request");
      sourceVideoId = parsed.data.video_id ?? null;
      // Forward bare-model JSON byte-for-byte, as upstream does. Only rewrite
      // when the provider prefix must be stripped or the default inserted.
      forwardBody =
        parsed.data.model === "grok-imagine-video"
          ? raw
          : JSON.stringify({ ...parsed.data, model: "grok-imagine-video" });
    } else {
      forwardBody = await readBoundedBytes(request, MAX_MULTIPART_BODY_BYTES);
      if (forwardBody.byteLength === 0) return failed(400, "Empty multipart video body");
    }
  } catch (error) {
    return failed(
      error instanceof Error && error.message === "too_large" ? 413 : 400,
      "Invalid video body"
    );
  }

  const model = "xai/grok-imagine-video";
  const policy = await enforceApiKeyPolicy(request, model);
  if (policy.rejection) return policy.rejection;

  const requestOwner = owner(request);
  const sourceJob =
    action === "extensions" && sourceVideoId
      ? getVideoJob(sourceVideoId, requestOwner) ||
        getVideoJobByUpstreamId(sourceVideoId, requestOwner)
      : null;
  if (sourceJob && (sourceJob.state !== "submitted" || !sourceJob.upstreamRequestId)) {
    return failed(409, "Source video job has no confirmed submission");
  }
  if (sourceJob && sourceVideoId === sourceJob.id && isJson) {
    // Local job IDs are stable for idempotency, but xAI expects its own ID.
    const parsed = JSON.parse(forwardBody as string) as Record<string, unknown>;
    forwardBody = JSON.stringify({ ...parsed, video_id: sourceJob.upstreamRequestId });
  }
  const requestedConnectionId = request.headers.get("x-connection-id");
  if (requestedConnectionId && !jobIdSchema.safeParse(requestedConnectionId).success) {
    return failed(400, "Invalid x-connection-id");
  }
  if (sourceJob && requestedConnectionId && requestedConnectionId !== sourceJob.connectionId) {
    return failed(409, "Source video belongs to a different connection");
  }
  const pinnedConnectionId = sourceJob?.connectionId || requestedConnectionId;

  const requestHash = createHash("sha256")
    .update(action)
    .update("\0")
    .update(contentType)
    .update("\0")
    .update(forwardBody)
    .digest("hex");
  const prior = idempotencyKey ? getVideoJobByIdempotency(requestOwner, idempotencyKey) : null;
  if (prior) {
    if (prior.requestHash !== requestHash) {
      return failed(409, "Idempotency-Key was used for a different video request");
    }
    return prior.state === "submitted"
      ? accepted(prior)
      : failed(409, `Video request ${prior.id} has no confirmed submission`);
  }

  const credentials = (await getProviderCredentialsWithQuotaPreflight(
    "xai",
    null,
    policy.apiKeyInfo?.allowedConnections ?? null,
    "grok-imagine-video",
    pinnedConnectionId ? { forcedConnectionId: pinnedConnectionId } : {}
  )) as VideoCredential | null;
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse("xai", credentials);
  }
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!credentials?.connectionId || !token || credentials.allExpired) {
    return failed(503, "No available xAI video connection");
  }
  if (pinnedConnectionId && credentials.connectionId !== pinnedConnectionId) {
    return failed(503, "Pinned xAI video connection is unavailable");
  }

  const reservation = reserveVideoJob({
    owner: requestOwner,
    idempotencyKey,
    requestHash,
    action,
    provider: "xai",
    model: "grok-imagine-video",
    connectionId: credentials.connectionId,
  });
  if (reservation.kind === "conflict") {
    return failed(409, "Idempotency-Key was used for a different video request");
  }
  if (reservation.kind === "existing") {
    return reservation.job.state === "submitted"
      ? accepted(reservation.job)
      : failed(409, `Video request ${reservation.job.id} has no confirmed submission`);
  }

  const config = getVideoProvider("xai");
  if (!config) {
    markVideoJobFailed(reservation.job.id);
    return failed(503, "xAI video provider is unavailable");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseUrl.replace(/\/$/, "")}/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: forwardBody,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(CREATE_TIMEOUT_MS)]),
    });
  } catch {
    markVideoJobUncertain(reservation.job.id);
    return json(
      {
        ...buildErrorBody(502, "Video submission outcome is unknown; do not retry with a new key"),
        request_id: reservation.job.id,
        status: "uncertain",
      },
      502
    );
  }

  if (!upstream.ok) {
    if (upstream.status >= 500) markVideoJobUncertain(reservation.job.id);
    else markVideoJobFailed(reservation.job.id);
    return failed(upstream.status >= 500 ? 502 : upstream.status, "xAI video submission failed");
  }

  let upstreamId: unknown;
  try {
    upstreamId = ((await upstream.json()) as { request_id?: unknown }).request_id;
  } catch {
    upstreamId = null;
  }
  if (typeof upstreamId !== "string" || !upstreamId || upstreamId.length > 512) {
    markVideoJobUncertain(reservation.job.id);
    return failed(502, "xAI accepted the video request without a usable job ID");
  }
  if (!markVideoJobSubmitted(reservation.job.id, upstreamId)) {
    return failed(503, "Video job state could not be committed");
  }
  await clearRecoveredProviderState(credentials as Record<string, unknown>);
  return accepted({ ...reservation.job, state: "submitted", upstreamRequestId: upstreamId });
}

/** Poll only the connection bound at creation; never rotate accounts. */
export async function getXaiAsyncVideo(request: Request, id: string): Promise<Response> {
  const auth = await enforceClientApiRouteAuth(request);
  if (auth) return auth;
  if (!jobIdSchema.safeParse(id).success) return failed(400, "Invalid video request ID");
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  const requestOwner = owner(request);
  const job = getVideoJob(id, requestOwner) || getVideoJobByUpstreamId(id, requestOwner);
  if (!job) return failed(404, "Video job not found");
  if (job.state === "reserved" || job.state === "uncertain") return accepted(job);
  if (job.state === "failed") return failed(502, "Video submission was rejected");
  if (job.provider !== "xai" || !job.upstreamRequestId) {
    return failed(503, "Video job cannot be polled");
  }

  const connection = await getProviderConnectionById(job.connectionId);
  if (!connection || connection.provider !== job.provider || connection.isActive === false) {
    return failed(503, "Creating video connection is unavailable");
  }
  const token = connection.apiKey || connection.accessToken;
  if (!token) return failed(503, "Creating video connection is unavailable");
  const config = getVideoProvider(job.provider);
  if (!config) return failed(503, "Video provider is unavailable");

  let upstream: Response;
  try {
    upstream = await fetch(
      `${(config.statusUrl || config.baseUrl).replace(/\/$/, "")}/${encodeURIComponent(job.upstreamRequestId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
      }
    );
  } catch {
    return failed(502, "xAI video status is temporarily unavailable");
  }
  if (!upstream.ok) return failed(502, "xAI video status is temporarily unavailable");

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return failed(502, "Invalid xAI video status response");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return failed(502, "Invalid xAI video status response");
  }
  const data = payload as Record<string, unknown>;
  const status =
    data.status === "pending" ||
    data.status === "processing" ||
    data.status === "done" ||
    data.status === "failed"
      ? data.status
      : "pending";
  const video =
    data.video && typeof data.video === "object" ? (data.video as Record<string, unknown>) : null;
  const videoUrl = typeof video?.url === "string" ? video.url : null;
  let safeUrl: string | null = null;
  if (videoUrl) {
    try {
      const parsedUrl = new URL(videoUrl);
      if (parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:") safeUrl = videoUrl;
    } catch {
      // Invalid provider URL is not exposed to clients.
    }
  }
  return json({
    request_id: job.upstreamRequestId,
    job_id: job.id,
    status,
    ...(typeof data.progress === "number" ? { progress: data.progress } : {}),
    ...(status === "done" && safeUrl ? { video: { url: safeUrl } } : {}),
    ...(status === "failed" ? { error: "Video generation failed" } : {}),
  });
}
