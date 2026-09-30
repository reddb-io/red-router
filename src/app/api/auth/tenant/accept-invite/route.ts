import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getCachedSettings } from "@/lib/db/settings";
import { getTenant } from "@/lib/db/tenants";
import {
  consumeTenantInvite,
  getTenantUserAuthById,
  setTenantUserPassword,
} from "@/lib/db/tenantAuth";
import { hashManagementPassword } from "@/lib/auth/managementPassword";
import { tenantPasswordProblem } from "@/lib/auth/tenantPassword";
import { checkLoginGuard, recordLoginFailure } from "@/server/auth/loginGuard";
import { getLoginLockoutKey } from "@/server/auth/loginPeer";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(1).max(200),
});

const INVALID_INVITE = { error: "This invitation is invalid or has expired." };

/**
 * POST /api/auth/tenant/accept-invite — a tenant user sets their password with the single-use token
 * the invitation gave them. Public by exact path. Bad tokens count toward the per-client lockout, so
 * the token space cannot be probed. It does not sign the user in: they sign in afterwards.
 */
export async function POST(request: NextRequest) {
  const auditContext = getAuditRequestContext(request);
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const validation = validateBody(acceptSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { token, password } = validation.data;

    const settings = await getCachedSettings();
    if (settings.requireLogin === false) {
      return NextResponse.json({ error: "Tenant sign-in is unavailable" }, { status: 403 });
    }
    const bruteForce = settings.bruteForceProtection !== false;
    const ip = getLoginLockoutKey(request, auditContext.ipAddress);
    const lockoutKey = `tenant-ip:${ip ?? "unknown"}`;
    const guard = checkLoginGuard(lockoutKey, { enabled: bruteForce });
    if (!guard.allowed) {
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(guard.retryAfterSeconds || 60) } }
      );
    }

    // A weak password is refused BEFORE the token is spent, so the person can try again.
    const problem = tenantPasswordProblem(password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const invite = consumeTenantInvite(token);
    const user = invite ? getTenantUserAuthById(invite.userId) : null;
    const tenant = user ? getTenant(user.tenantId) : null;
    if (!invite || !user || user.disabled || !tenant || tenant.disabled) {
      recordLoginFailure(lockoutKey, { enabled: bruteForce });
      return NextResponse.json(INVALID_INVITE, { status: 400 });
    }

    setTenantUserPassword(user.id, await hashManagementPassword(password));
    logAuditEvent({
      action: "tenant.invite.accepted",
      actor: `tenant:${tenant.slug}/${user.email}`,
      target: user.id,
      resourceType: "tenant_user",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { tenantId: tenant.id },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AUTH] Invitation acceptance failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
