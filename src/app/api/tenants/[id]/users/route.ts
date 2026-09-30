import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { createTenantUser, getTenant, listTenantUsers } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, createTenantUserSchema, tenantFailure } from "../../_lib";
import { auditActorFor } from "@/lib/compliance/auditActor";

type Context = { params: Promise<{ id: string }> };

/** GET /api/tenants/:id/users — the tenant's admins and users. */
export async function GET(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;
  const tenant = getTenant(id);
  if (!tenant) {
    return NextResponse.json({ error: { message: "Tenant not found." } }, { status: 404 });
  }
  return NextResponse.json({ users: listTenantUsers(tenant.id) });
}

/** POST /api/tenants/:id/users — add a user, or assign the tenant's admin with role "admin". */
export async function POST(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(createTenantUserSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const tenant = getTenant(id);
    const user = createTenantUser(tenant?.id ?? id, validation.data);
    logAuditEvent({
      action: "tenant.user.created",
      actor: await auditActorFor(request),
      target: user.id,
      resourceType: "tenant_user",
      status: "success",
      metadata: { tenantId: user.tenantId, role: user.role },
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return tenantFailure(error, "Failed to create user");
  }
}
