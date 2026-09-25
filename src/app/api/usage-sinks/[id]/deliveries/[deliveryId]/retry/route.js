import { NextResponse } from "next/server";
import { getUsageSinkById, getDeliveryById } from "@/lib/db/repos/usageSinksRepo.js";
import { attemptDelivery } from "@/lib/usageSinks/engine.js";

// POST /api/usage-sinks/{id}/deliveries/{deliveryId}/retry — send a pending or
// dead delivery now, with the same id so the receiver can still dedupe it.
export async function POST(_request, { params }) {
  const { id, deliveryId } = await params;
  const sink = await getUsageSinkById(id);
  const delivery = await getDeliveryById(deliveryId);
  if (!sink || !delivery || delivery.sinkId !== id) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });
  if (delivery.status === "delivered") return NextResponse.json({ error: "Already delivered" }, { status: 409 });
  // A dead delivery gets a fresh retry budget from here.
  const result = await attemptDelivery({ ...delivery, attempts: delivery.status === "dead" ? 0 : delivery.attempts }, sink);
  return NextResponse.json({ ok: result.ok, status: result.status, error: result.ok ? null : result.error, durationMs: result.durationMs });
}
