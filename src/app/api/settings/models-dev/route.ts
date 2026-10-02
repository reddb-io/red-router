import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  syncModelsDev,
  getModelsDevPricing,
  getSyncStatus,
  startPeriodicSync,
  stopPeriodicSync,
} from "@/lib/modelsDevSync";
import { getBundledModelsDevManifest } from "@/lib/catalog/modelsDevSeed";
import { MODELS_DEV_TRANSFORM_VERSION } from "@/lib/modelsDevSync/transform";

const modelsDevActionSchema = z.object({
  action: z.enum(["sync", "start", "stop"]),
  dryRun: z.boolean().optional(),
  syncCapabilities: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireManagementAuth(request);
  if (auth) return auth;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "status") {
    const status = getSyncStatus();
    const pricing = getModelsDevPricing();

    const providerCount = Object.keys(pricing).length;
    const modelCount = Object.values(pricing).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    // Connection-discovered rows are a different catalog source.
    const capabilityCount =
      status.snapshot?.transformVersion === MODELS_DEV_TRANSFORM_VERSION
        ? (status.snapshot.capabilityCount ?? 0)
        : 0;

    return NextResponse.json({
      ...status,
      bundledSnapshot: getBundledModelsDevManifest(),
      providerCount,
      modelCount,
      capabilityCount,
    });
  }

  return NextResponse.json(buildErrorBody(400, "Unknown action"), { status: 400 });
}

export async function POST(request: NextRequest) {
  const auth = await requireManagementAuth(request);
  if (auth) return auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(buildErrorBody(400, "Invalid JSON body"), { status: 400 });
  }

  const validation = validateBody(modelsDevActionSchema, rawBody);
  if (isValidationFailure(validation)) {
    return validation.response;
  }

  const { action, dryRun, syncCapabilities } = validation.data;

  if (action === "sync") {
    const result = await syncModelsDev({
      dryRun: dryRun ?? false,
      syncCapabilities: syncCapabilities !== false,
      force: true,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    });
    return NextResponse.json(
      { ...result, ...(result.error ? { error: sanitizeErrorMessage(result.error) } : {}) },
      { status: result.success ? 200 : 503 }
    );
  }

  if (action === "start") {
    startPeriodicSync();
    return NextResponse.json({ success: true, message: "Periodic sync started" });
  }

  if (action === "stop") {
    stopPeriodicSync();
    return NextResponse.json({ success: true, message: "Periodic sync stopped" });
  }

  return NextResponse.json(buildErrorBody(400, "Unknown action"), { status: 400 });
}
