import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { getResourceTenantId, getTenant, setResourceShared, TenantError } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, sharedResourceSchema, tenantFailure } from "../../_lib";
import { auditActorFor } from "@/lib/compliance/auditActor";

type Context = { params: Promise<{ id: string }> };

/** PUT /api/tenants/:id/shared — share one of this tenant's connections/combos with every tenant. */
export async function PUT(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(sharedResourceSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { kind, id: resourceId, shared } = validation.data;

  try {
    const tenant = getTenant(id);
    if (!tenant) throw new TenantError("not_found", "Tenant not found.");
    // Only the owning tenant can share a resource.
    const ownerTenantId = getResourceTenantId(kind, resourceId);
    if (ownerTenantId === null) throw new TenantError("not_found", "Resource not found.");
    if (ownerTenantId !== tenant.id) {
      throw new TenantError("forbidden", "The resource belongs to another tenant.");
    }
    setResourceShared(kind, resourceId, shared);
    logAuditEvent({
      action: shared ? "tenant.resource.shared" : "tenant.resource.unshared",
      actor: await auditActorFor(request),
      target: resourceId,
      resourceType: kind,
      status: "success",
      metadata: { tenantId: tenant.id },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return tenantFailure(error, "Failed to update sharing");
  }
}
