import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { listRoutingProfiles } from "@/lib/db/routingProfiles";
import { mutateProfile } from "./_lib";

export async function GET(request: Request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    return NextResponse.json(
      { profiles: listRoutingProfiles() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return createErrorResponse({ status: 500, message: "Could not load routing profiles." });
  }
}
export async function POST(request: Request) {
  return mutateProfile(request, "save");
}
