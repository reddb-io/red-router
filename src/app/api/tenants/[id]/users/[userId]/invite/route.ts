import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { getTenant, getTenantUser } from "@/lib/db/tenants";
import { createTenantInvite } from "@/lib/db/tenantAuth";

type Context = { params: Promise<{ id: string; userId: string }> };

/**
 * POST /api/tenants/:id/users/:userId/invite — mint a single-use invitation so the user can set their
 * password. The token is returned once and expires in seven days; an earlier invitation stops working.
 */
export async function POST(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id, userId } = await context.params;

  const tenant = getTenant(id);
  const user = getTenantUser(userId);
  if (!tenant || !user || user.tenantId !== tenant.id) {
    return NextResponse.json({ error: { message: "User not found." } }, { status: 404 });
  }
  const actor = await auditActorFor(request);
  const invite = createTenantInvite({ tenantId: tenant.id, userId: user.id, createdBy: actor });
  logAuditEvent({
    action: "tenant.invite.created",
    actor,
    target: user.id,
    resourceType: "tenant_user",
    status: "success",
    metadata: { tenantId: tenant.id },
  });
  return NextResponse.json({ token: invite.token, expiresAt: invite.expiresAt }, { status: 201 });
}
