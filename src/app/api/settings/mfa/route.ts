import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { OWNER_PRINCIPAL, getMfaState } from "@/lib/db/mfa";

/** GET /api/settings/mfa — whether the second factor is on. Never returns the secret. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(getMfaState(OWNER_PRINCIPAL));
}
