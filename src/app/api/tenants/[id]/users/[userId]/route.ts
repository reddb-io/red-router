import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { deleteTenantUser, getTenant, updateTenantUser } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, tenantFailure, updateTenantUserSchema } from "../../../_lib";
import { auditActorFor } from "@/lib/compliance/auditActor";

type Context = { params: Promise<{ id: string; userId: string }> };

/** PATCH /api/tenants/:id/users/:userId — change role, display name or disabled flag. */
export async function PATCH(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id, userId } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(updateTenantUserSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const user = updateTenantUser(getTenant(id)?.id ?? id, userId, validation.data);
    logAuditEvent({
      action: "tenant.user.updated",
      actor: await auditActorFor(request),
      target: user.id,
      resourceType: "tenant_user",
      status: "success",
      metadata: { tenantId: user.tenantId, role: user.role, disabled: user.disabled },
    });
    return NextResponse.json({ user });
  } catch (error) {
    return tenantFailure(error, "Failed to update user");
  }
}

/** DELETE /api/tenants/:id/users/:userId — remove the user from the tenant. */
export async function DELETE(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id, userId } = await context.params;
  try {
    deleteTenantUser(getTenant(id)?.id ?? id, userId);
    logAuditEvent({
      action: "tenant.user.deleted",
      actor: await auditActorFor(request),
      target: userId,
      resourceType: "tenant_user",
      status: "success",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return tenantFailure(error, "Failed to delete user");
  }
}
