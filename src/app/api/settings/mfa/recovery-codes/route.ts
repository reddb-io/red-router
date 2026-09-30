import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { OWNER_PRINCIPAL, regenerateRecoveryCodes } from "@/lib/db/mfa";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON, badCode, proofSchema, proveSecondFactor } from "../_lib";

/** POST /api/settings/mfa/recovery-codes — replace the recovery codes; needs a current code. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON, { status: 400 });
  }
  const validation = validateBody(proofSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  if (!proveSecondFactor(validation.data)) return badCode();

  const recoveryCodes = regenerateRecoveryCodes(OWNER_PRINCIPAL);
  if (!recoveryCodes) return badCode();
  logAuditEvent({
    action: "auth.mfa.recovery_regenerated",
    actor: await auditActorFor(request),
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
  });
  return NextResponse.json({ recoveryCodes });
}
