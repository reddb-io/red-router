import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUsageSink, listUsageDeliveriesPage, type UsageDelivery } from "@/lib/db/usageSinks";
import { deliveriesQuerySchema } from "@/lib/usageSinks/inputSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type RouteContext = { params: Promise<{ id: string }> };

interface Totals {
  requests?: number;
  cost?: number;
}

/** The payload, reduced to what the deliveries table shows (the payload itself stays server-side). */
function summarize(payload: UsageDelivery["payload"]) {
  const type = typeof payload?.type === "string" ? payload.type : null;
  if (type === "usage.window") {
    const keys = Array.isArray(payload.keys) ? (payload.keys as Array<{ totals?: Totals }>) : [];
    const window = (payload.window ?? {}) as { start?: string; end?: string };
    return {
      kind: "window" as const,
      windowStart: window.start ?? null,
      windowEnd: window.end ?? null,
      keys: keys.length,
      requests: keys.reduce((sum, key) => sum + (key.totals?.requests ?? 0), 0),
      cost: keys.reduce((sum, key) => sum + (key.totals?.cost ?? 0), 0),
      model: null,
    };
  }
  const event = (payload?.event ?? {}) as { cost?: number; model?: string };
  return {
    kind: "event" as const,
    windowStart: null,
    windowEnd: null,
    keys: 1,
    requests: 1,
    cost: event.cost ?? 0,
    model: event.model ?? null,
  };
}

/** GET /api/usage-sinks/{id}/deliveries?page=&pageSize=&status=: a page of deliveries, newest first. */
export async function GET(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!getUsageSink(id)) {
    return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  }
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = validateBody(deliveriesQuerySchema, query);
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { page, pageSize, status } = parsed.data;
  const { deliveries, total } = listUsageDeliveriesPage(id, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
    status,
  });
  return NextResponse.json({
    deliveries: deliveries.map(({ payload, ...delivery }) => ({
      ...delivery,
      ...summarize(payload),
    })),
    page,
    pageSize,
    total,
  });
}
