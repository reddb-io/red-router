import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { retryUsageDelivery } from "@/lib/usageSinks/engine";

type RouteContext = { params: Promise<{ id: string; deliveryId: string }> };

/**
 * POST /api/usage-sinks/{id}/deliveries/{deliveryId}/retry: send a pending or dead delivery now,
 * with the same delivery id so the receiver can still dedupe it. A dead delivery gets a fresh
 * retry budget. The attempt goes through the outbox lease, so it cannot race the scheduled
 * dispatch into a double send.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id, deliveryId } = await params;
  const outcome = await retryUsageDelivery(id, deliveryId);
  switch (outcome.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Delivery not found" }, { status: 404 });
    case "delivered":
      return NextResponse.json({ error: "Already delivered" }, { status: 409 });
    case "in_flight":
      return NextResponse.json(
        { error: "Delivery is being sent by another worker; try again shortly" },
        { status: 409 }
      );
    default:
      return NextResponse.json({
        ok: outcome.result.ok,
        status: outcome.result.status,
        error: outcome.result.ok ? null : outcome.result.error,
        durationMs: outcome.result.durationMs,
      });
  }
}
