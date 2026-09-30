import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { createTenant, listTenants } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, createTenantSchema, tenantFailure } from "./_lib";

/** GET /api/tenants — every tenant with its member and resource counts. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ tenants: listTenants() });
  } catch (error) {
    return tenantFailure(error, "Failed to list tenants");
  }
}

/** POST /api/tenants — create a tenant. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(createTenantSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const tenant = createTenant(validation.data);
    logAuditEvent({
      action: "tenant.created",
      actor: "admin",
      target: tenant.id,
      resourceType: "tenant",
      status: "success",
      metadata: { slug: tenant.slug },
    });
    return NextResponse.json({ tenant }, { status: 201 });
  } catch (error) {
    return tenantFailure(error, "Failed to create tenant");
  }
}
