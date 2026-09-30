import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { logAuditEvent } from "@/lib/compliance/index";
import { getTenantProfile, saveTenantProfile, tenantProfileSchema } from "@/lib/db/tenantProfiles";
import { getTenant, TenantError } from "@/lib/db/tenants";
import { INVALID_JSON_BODY, tenantFailure } from "../../_lib";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    if (!getTenant(id)) throw new TenantError("not_found", "Tenant not found.");
    return NextResponse.json({ profile: getTenantProfile(id) });
  } catch (error) {
    return tenantFailure(error, "Failed to load tenant profile");
  }
}
export async function PUT(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const parsed = tenantProfileSchema.safeParse(body);
  if (!parsed.success)
    return tenantFailure(
      new TenantError("invalid", "Invalid tenant profile."),
      "Invalid tenant profile"
    );
  try {
    const { id } = await context.params;
    const profile = saveTenantProfile(id, parsed.data);
    logAuditEvent({
      action: "tenant.profile.updated",
      actor: await auditActorFor(request),
      target: id,
      resourceType: "tenant",
      status: "success",
      metadata: { ownerUserId: profile.ownerUserId },
    });
    return NextResponse.json({ profile });
  } catch (error) {
    return tenantFailure(error, "Failed to save tenant profile");
  }
}
