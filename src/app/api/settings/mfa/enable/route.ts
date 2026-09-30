import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { OWNER_PRINCIPAL, enableMfa } from "@/lib/db/mfa";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON, badCode, codeSchema } from "../_lib";

/** POST /api/settings/mfa/enable — confirm the authenticator with a code; returns recovery codes once. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON, { status: 400 });
  }
  const validation = validateBody(codeSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const enabled = enableMfa(OWNER_PRINCIPAL, validation.data.code);
  if (!enabled) return badCode();
  logAuditEvent({
    action: "auth.mfa.enabled",
    actor: await auditActorFor(request),
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
  });
  return NextResponse.json({ enabled: true, recoveryCodes: enabled.recoveryCodes });
}
