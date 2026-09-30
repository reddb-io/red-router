import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { OWNER_PRINCIPAL, beginMfaSetup } from "@/lib/db/mfa";
import { otpauthUri } from "@/lib/auth/totp";

/**
 * POST /api/settings/mfa/setup — mint a pending secret. It only starts gating sign-in once
 * /enable proves the authenticator produces a valid code. The secret is returned once, here.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const started = beginMfaSetup(OWNER_PRINCIPAL);
  if (!started) {
    return NextResponse.json(
      { error: "A second factor is already enabled. Disable it first." },
      { status: 409 }
    );
  }
  logAuditEvent({
    action: "auth.mfa.setup_started",
    actor: await auditActorFor(request),
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
  });
  return NextResponse.json({
    secret: started.secret,
    otpauthUri: otpauthUri({
      issuer: "RedRouter",
      account: "owner",
      secret: started.secret,
    }),
  });
}
