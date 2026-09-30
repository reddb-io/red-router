import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { deleteTenant, updateTenant } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, tenantFailure, updateTenantSchema } from "../_lib";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/tenants/:id — rename or disable a tenant (a disabled tenant's keys stop working). */
export async function PATCH(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(updateTenantSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const tenant = updateTenant(id, validation.data);
    logAuditEvent({
      action: "tenant.updated",
      actor: "admin",
      target: tenant.id,
      resourceType: "tenant",
      status: "success",
      metadata: { disabled: tenant.disabled },
    });
    return NextResponse.json({ tenant });
  } catch (error) {
    return tenantFailure(error, "Failed to update tenant");
  }
}

/** DELETE /api/tenants/:id — delete an empty, non-default tenant. */
export async function DELETE(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;
  try {
    deleteTenant(id);
    logAuditEvent({
      action: "tenant.deleted",
      actor: "admin",
      target: id,
      resourceType: "tenant",
      status: "success",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return tenantFailure(error, "Failed to delete tenant");
  }
}
