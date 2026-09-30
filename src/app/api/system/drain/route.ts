/**
 * Operator drain for rolling restarts.
 *  GET    state
 *  POST   start draining: /readyz answers 503 "draining", new client API requests answer 503
 *         with Retry-After, in-flight requests and streams finish untouched
 *  DELETE stop draining
 * The flag is process-local and cleared by a restart.
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getActiveRequestCount } from "@/lib/gracefulShutdown";
import { getManualDrainState, startManualDrain, stopManualDrain } from "@/lib/system/drainMode";

export const dynamic = "force-dynamic";

function view(state: ReturnType<typeof getManualDrainState>) {
  return { ...state, inFlight: getActiveRequestCount() };
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(view(getManualDrainState()), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(view(startManualDrain()), { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(view(stopManualDrain()), { headers: { "Cache-Control": "no-store" } });
}
