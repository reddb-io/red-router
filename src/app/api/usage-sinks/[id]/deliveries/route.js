import { NextResponse } from "next/server";
import { getUsageSinkById, getDeliveries } from "@/lib/db/repos/usageSinksRepo.js";

function summarize(payload) {
  if (!payload) return null;
  if (payload.type === "usage.window") {
    const keys = payload.keys || [];
    return { keys: keys.length, requests: keys.reduce((n, k) => n + (k.totals?.requests || 0), 0), cost: keys.reduce((n, k) => n + (k.totals?.cost || 0), 0) };
  }
  return { keys: 1, requests: 1, cost: payload.event?.cost || 0, model: payload.event?.model || null };
}

// GET /api/usage-sinks/{id}/deliveries — the latest deliveries (payload summarized).
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!(await getUsageSinkById(id))) return NextResponse.json({ error: "Sink not found" }, { status: 404 });
  const deliveries = await getDeliveries(id, { limit: 50 });
  return NextResponse.json({
    deliveries: deliveries.map(({ payload, ...d }) => ({ ...d, summary: summarize(payload) })),
  });
}
