import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { OWNER_PRINCIPAL, disableMfa } from "@/lib/db/mfa";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON, badCode, passwordMatches, proofSchema, proveSecondFactor } from "../_lib";

/** POST /api/settings/mfa/disable — needs the password AND a code (or recovery code). */
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

  if (!(await passwordMatches(validation.data.password))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }
  if (!proveSecondFactor(validation.data)) return badCode();

  disableMfa(OWNER_PRINCIPAL);
  logAuditEvent({
    action: "auth.mfa.disabled",
    actor: await auditActorFor(request),
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
  });
  return NextResponse.json({ enabled: false });
}
