/**
 * POST /api/providers/[id]/test-models
 *
 * `id` is a provider connection id. Lists the models known for that connection and probes each
 * one through the shared single-model runner (`runSingleModelTest`), pinned to the connection,
 * so the internal endpoint matching the model kind (chat, responses, embeddings, rerank,
 * transcription) is used exactly as the "Test" button does. This route only orchestrates.
 *
 * Bounds: at most MAX_MODELS models per call, concurrency of 1 to MAX_CONCURRENCY, a per-model
 * timeout of at most MAX_PER_MODEL_TIMEOUT_MS and an overall deadline after which no further
 * probe starts. Errors in the response are fixed strings — upstream bodies are never echoed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  DEFAULT_MODEL_TEST_TIMEOUT_MS,
  resolveModelTestKind,
  runSingleModelTest,
  type ModelTestKind,
  type SingleModelTestResult,
} from "@/lib/api/modelTestRunner";
import { getCustomModels, getSyncedAvailableModelsForConnection } from "@/lib/db/models";
import { getProviderConnectionById } from "@/lib/db/providers";
import { getSettings } from "@/lib/db/settings";
import { getModelsByProviderId } from "@/shared/constants/models";
import { isFreeModel, providerHasFreeModels } from "@/shared/utils/freeModels";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const MAX_MODELS = 50;
const MAX_CONCURRENCY = 3;
const MAX_PER_MODEL_TIMEOUT_MS = 30_000;
const OVERALL_DEADLINE_MS = 120_000;
/** Same 429-storm guard as the batch endpoint: stop instead of burning every timeout. */
const CONSECUTIVE_RATE_LIMIT_STOP_THRESHOLD = 3;
/** Grace over the runner's own timer before the hard timeout answers for it. */
const HARD_TIMEOUT_GRACE_MS = 1_000;

const testModelsBodySchema = z
  .object({
    modelIds: z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_MODELS).optional(),
    concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(1),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_PER_MODEL_TIMEOUT_MS)
      .default(Math.min(DEFAULT_MODEL_TEST_TIMEOUT_MS, MAX_PER_MODEL_TIMEOUT_MS)),
  })
  .strict();

type ModelEntry = { id: string; name: string };

export interface ModelProbeResult {
  model: string;
  kind: ModelTestKind | "unknown";
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  skipped?: boolean;
}

function stripProviderPrefix(modelId: string, provider: string): string {
  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/** Local catalog only (synced + custom + registry): no upstream call is made to list models. */
async function listConnectionModels(connectionId: string, provider: string): Promise<ModelEntry[]> {
  const models = new Map<string, ModelEntry>();
  const add = (rawId: unknown, rawName: unknown) => {
    if (typeof rawId !== "string" || !rawId.trim()) return;
    const id = stripProviderPrefix(rawId.trim(), provider);
    if (!id || models.has(id)) return;
    models.set(id, { id, name: typeof rawName === "string" && rawName ? rawName : id });
  };

  for (const model of await getSyncedAvailableModelsForConnection(provider, connectionId)) {
    add(model.id, model.name);
  }
  const custom = await getCustomModels(provider);
  if (Array.isArray(custom)) {
    for (const model of custom) add(model?.id, model?.name);
  }
  for (const model of getModelsByProviderId(provider)) add(model.id, model.name);
  return [...models.values()];
}

function fixedFailureMessage(result: SingleModelTestResult, kind: ModelProbeResult["kind"]) {
  if (result.isTimeout || result.status === "slow") return "Model test timed out";
  if (result.rateLimited || result.status === "rate_limited") return "Rate limited by the upstream";
  if (result.statusCode === undefined && result.httpStatus === 422) {
    return kind === "non-chat"
      ? "Skipped: non-chat generation model, use its generation endpoint"
      : "Skipped: web-session providers are not probed";
  }
  if (result.statusCode === undefined && result.httpStatus === 409) {
    return "Model tests are unavailable for this connection";
  }
  const status = result.statusCode ?? result.httpStatus;
  if (status === 200) return "Provider returned no model output";
  if (status === 401 || status === 403) return "Upstream rejected the credentials";
  if (status === 404) return "Model not found upstream";
  if (status >= 400 && status < 500) return "Upstream rejected the request";
  if (status >= 500) return "Upstream error";
  return "Model test failed";
}

function toProbeResult(
  model: string,
  kind: ModelProbeResult["kind"],
  result: SingleModelTestResult
): ModelProbeResult {
  const ok = result.status === "ok";
  const skipped = !ok && result.statusCode === undefined && result.httpStatus === 422;
  return {
    model,
    kind,
    ok,
    status: result.statusCode ?? result.httpStatus,
    latencyMs: result.latencyMs,
    ...(ok ? {} : { error: fixedFailureMessage(result, kind) }),
    ...(skipped ? { skipped: true } : {}),
  };
}

function skippedResult(model: string, error: string): ModelProbeResult {
  return { model, kind: "unknown", ok: false, error, skipped: true };
}

/** Answer for a probe that outlived the runner's own timer (some providers stretch it). */
async function withHardTimeout(
  run: Promise<SingleModelTestResult>,
  ms: number
): Promise<SingleModelTestResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SingleModelTestResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ modelId: "", status: "slow", latencyMs: ms, httpStatus: 504, isTimeout: true }),
      ms
    );
  });
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) rawBody = JSON.parse(text);
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = testModelsBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid request",
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        message: issue.message,
      })),
    });
  }
  const { modelIds, concurrency, timeoutMs } = parsed.data;

  try {
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return createErrorResponse({ status: 404, message: "Connection not found" });
    }
    if (connection.isActive === false) {
      return createErrorResponse({ status: 409, message: "Connection is disabled" });
    }
    const provider = String(connection.provider);

    const available = await listConnectionModels(id, provider);
    if (available.length === 0) {
      return createErrorResponse({
        status: 400,
        message: "No models are listed for this connection",
      });
    }

    const availableIds = new Set(available.map((model) => model.id));
    const unknown: ModelProbeResult[] = [];
    let queue: ModelEntry[];
    if (modelIds) {
      const wanted = [
        ...new Set(modelIds.map((modelId) => stripProviderPrefix(modelId, provider))),
      ];
      queue = available.filter((model) => wanted.includes(model.id));
      for (const modelId of wanted) {
        if (!availableIds.has(modelId)) {
          unknown.push(skippedResult(modelId, "Model is not listed for this connection"));
        }
      }
    } else {
      queue = available;
    }
    const truncated = queue.length > MAX_MODELS;
    if (truncated) queue = queue.slice(0, MAX_MODELS);

    let hidePaid = false;
    try {
      hidePaid = (await getSettings())?.hidePaidModels === true;
    } catch {
      // Fail open on a settings read, like the single-model route.
    }

    const deadline = Date.now() + OVERALL_DEADLINE_MS;
    const results: ModelProbeResult[] = new Array(queue.length);
    let consecutiveRateLimits = 0;
    let stopReason: "consecutive_rate_limits" | "deadline" | undefined;

    const probe = async (index: number) => {
      const { id: modelId } = queue[index];
      if (stopReason) {
        results[index] = skippedResult(
          modelId,
          stopReason === "deadline"
            ? "Skipped: overall time limit reached"
            : "Skipped: stopped after repeated rate limits"
        );
        return;
      }
      if (Date.now() > deadline) {
        stopReason = "deadline";
        results[index] = skippedResult(modelId, "Skipped: overall time limit reached");
        return;
      }
      if (
        hidePaid &&
        !(providerHasFreeModels(provider) && isFreeModel(provider, { id: modelId }))
      ) {
        results[index] = skippedResult(modelId, "Skipped: paid model with hidePaidModels enabled");
        return;
      }

      const fullModelId = `${provider}/${modelId}`;
      try {
        const kind = await resolveModelTestKind(provider, fullModelId);
        const result = await withHardTimeout(
          runSingleModelTest({
            providerId: provider,
            modelId: fullModelId,
            connectionId: id,
            timeoutMs,
            streamChat: true,
          }),
          timeoutMs + HARD_TIMEOUT_GRACE_MS
        );
        results[index] = toProbeResult(modelId, kind, result);
        if (result.rateLimited) {
          consecutiveRateLimits += 1;
          if (consecutiveRateLimits >= CONSECUTIVE_RATE_LIMIT_STOP_THRESHOLD) {
            stopReason = "consecutive_rate_limits";
          }
        } else {
          consecutiveRateLimits = 0;
        }
      } catch (error: unknown) {
        results[index] = {
          model: modelId,
          kind: "unknown",
          ok: false,
          error: sanitizeErrorMessage(error) || "Model test failed",
        };
      }
    };

    // Warm up on the first model alone so a token refresh is not raced by parallel probes.
    let next = 0;
    if (queue.length > 0 && concurrency > 1) {
      await probe(next);
      next += 1;
    }
    const worker = async () => {
      while (next < queue.length) {
        const index = next;
        next += 1;
        await probe(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    const allResults = [...results, ...unknown];
    return NextResponse.json({
      provider,
      connectionId: id,
      total: available.length,
      tested: allResults.filter((entry) => !entry.skipped).length,
      ...(truncated ? { truncated: true, limit: MAX_MODELS } : {}),
      ...(stopReason ? { stoppedEarly: true, stopReason } : {}),
      summary: {
        ok: allResults.filter((entry) => entry.ok).length,
        failed: allResults.filter((entry) => !entry.ok && !entry.skipped).length,
        skipped: allResults.filter((entry) => entry.skipped).length,
      },
      results: allResults,
    });
  } catch (error: unknown) {
    return createErrorResponse({
      status: 500,
      message: sanitizeErrorMessage(error) || "Test failed",
    });
  }
}
