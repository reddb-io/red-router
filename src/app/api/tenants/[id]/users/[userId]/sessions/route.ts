import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { getTenant, getTenantUser } from "@/lib/db/tenants";
import { bumpTenantUserSessionVersion } from "@/lib/db/tenantAuth";

type Context = { params: Promise<{ id: string; userId: string }> };

/** DELETE /api/tenants/:id/users/:userId/sessions — sign the user out everywhere, at once. */
export async function DELETE(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id, userId } = await context.params;

  const tenant = getTenant(id);
  const user = getTenantUser(userId);
  if (!tenant || !user || user.tenantId !== tenant.id) {
    return NextResponse.json({ error: { message: "User not found." } }, { status: 404 });
  }
  bumpTenantUserSessionVersion(user.id);
  logAuditEvent({
    action: "tenant.user.sessions_revoked",
    actor: await auditActorFor(request),
    target: user.id,
    resourceType: "tenant_user",
    status: "success",
    metadata: { tenantId: tenant.id },
  });
  return NextResponse.json({ success: true });
}
