import { NextResponse } from "next/server";
import { getUsageSinks, createUsageSink, getDeliveryStats } from "@/lib/db/repos/usageSinksRepo.js";
import { parseSinkInput, publicSink } from "@/lib/usageSinks/input.js";

// GET /api/usage-sinks — every sink, secrets redacted, with delivery counts.
export async function GET() {
  const [sinks, stats] = await Promise.all([getUsageSinks(), getDeliveryStats()]);
  return NextResponse.json({ sinks: sinks.map((s) => publicSink(s, stats[s.id])) });
}

// POST /api/usage-sinks — create a sink; it starts from usage recorded from now on.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { value, error } = parseSinkInput(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const sink = await createUsageSink(value);
  return NextResponse.json({ sink: publicSink(sink) }, { status: 201 });
}
