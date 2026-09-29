import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { getCachePrefixSummary } from "@/lib/db/cachePrefixObservations";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

/** GET /api/cache/prefix?days=7 — how often requests kept the cacheable prefix, and why not. */
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
    return NextResponse.json(getCachePrefixSummary({ days: Number.isFinite(days) ? days : 7 }));
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
