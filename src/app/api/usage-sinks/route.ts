import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyRefsByIds } from "@/lib/db/apiKeyLookup";
import { createUsageSink, getUsageDeliveryStats, listUsageSinks } from "@/lib/db/usageSinks";
import { bodyConfig, createSinkSchema } from "@/lib/usageSinks/inputSchemas";
import { resolveSinkConfig, usageSinkView } from "@/lib/usageSinks/sinkConfig";
import { EMPTY_DELIVERY_STATS } from "@/lib/usageSinks/types";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const sinks = listUsageSinks();
    const stats = getUsageDeliveryStats();
    // Names of the keys the filters pick, looked up by id: the page never loads every key.
    const names = new Map(
      getApiKeyRefsByIds(sinks.flatMap((sink) => sink.apiKeyIds)).map((key) => [key.id, key])
    );
    return NextResponse.json({
      sinks: sinks.map((sink) => ({
        ...usageSinkView(sink, stats[sink.id] ?? EMPTY_DELIVERY_STATS),
        filterKeys: sink.apiKeyIds.map((id) => names.get(id) ?? { id, name: null, deleted: true }),
      })),
    });
  } catch (error) {
    console.error("[RedRouter UsageSinks] List failed:", error);
    return NextResponse.json({ error: "Could not list usage sinks" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  const parsed = validateBody(createSinkSchema, body);
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { data } = parsed;
  const config = resolveSinkConfig(data.type, bodyConfig(data.type, data) ?? {});
  if (!config.ok) return NextResponse.json({ error: config.error }, { status: 400 });
  try {
    const sink = createUsageSink({
      name: data.name,
      type: data.type,
      config: config.stored,
      mode: data.mode,
      windowSec: data.windowSec,
      apiKeyIds: data.apiKeyIds,
      enabled: data.enabled,
    });
    return NextResponse.json({ sink: usageSinkView(sink) }, { status: 201 });
  } catch (error) {
    console.error("[RedRouter UsageSinks] Create failed:", error);
    return NextResponse.json({ error: "Could not create usage sink" }, { status: 500 });
  }
}
