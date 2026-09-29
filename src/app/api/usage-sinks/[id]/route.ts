import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  deleteUsageSink,
  getUsageSink,
  listUsageDeliveries,
  updateUsageSink,
} from "@/lib/db/usageSinks";
import { bodyConfig, updateSinkSchema } from "@/lib/usageSinks/inputSchemas";
import { resolveSinkConfig, usageSinkView } from "@/lib/usageSinks/sinkConfig";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const sink = getUsageSink(id);
  if (!sink) return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  return NextResponse.json({ sink: usageSinkView(sink), deliveries: listUsageDeliveries(id) });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const current = getUsageSink(id);
  if (!current) return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  const parsed = validateBody(updateSinkSchema, await request.json().catch(() => null));
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { data } = parsed;
  // A config change is validated as a whole against the stored one: credentials the caller did
  // not resend (or sent back as the placeholder) keep their stored ciphertext.
  const incoming = bodyConfig(current.type, data);
  let config: Record<string, unknown> | undefined;
  if (incoming !== undefined) {
    const resolved = resolveSinkConfig(current.type, incoming, current.config);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    config = resolved.stored;
  }
  try {
    const sink = updateUsageSink(id, {
      name: data.name,
      config,
      mode: data.mode,
      windowSec: data.windowSec,
      enabled: data.enabled,
      apiKeyIds: data.apiKeyIds,
    });
    return NextResponse.json({ sink: usageSinkView(sink!) });
  } catch (error) {
    console.error("[RedRouter UsageSinks] Update failed:", error);
    return NextResponse.json({ error: "Could not update usage sink" }, { status: 500 });
  }
}

// The original API used PUT for the same partial update.
export const PUT = PATCH;

export async function DELETE(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!deleteUsageSink(id)) {
    return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
