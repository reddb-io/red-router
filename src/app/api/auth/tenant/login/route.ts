import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getCachedSettings } from "@/lib/db/settings";
import { getTenant } from "@/lib/db/tenants";
import { getTenantUserAuthByEmail, touchTenantUserLogin } from "@/lib/db/tenantAuth";
import { isMfaEnabled } from "@/lib/db/mfa";
import { hashManagementPassword, verifyManagementPassword } from "@/lib/auth/managementPassword";
import { mintMfaChallenge } from "@/lib/auth/mfaChallenge";
import { setTenantSessionCookie } from "@/lib/auth/tenantSessionCookie";
import { getDashboardJwtSecret } from "@/shared/utils/dashboardSessionToken";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";
import { getLoginLockoutKey } from "@/server/auth/loginPeer";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

// One answer for every reason a sign-in can fail, so the response never reveals whether an e-mail
// exists, has a password, or belongs to a disabled user or tenant.
const INVALID = { error: "Invalid email or password" };

// A real bcrypt hash to compare against when the user is unknown, so the time taken does not tell.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashManagementPassword("not-a-real-tenant-password"));

/**
 * POST /api/auth/tenant/login — a tenant admin or user signs in with e-mail and password. Public by
 * exact path. Lockout is per client address, in its own bucket apart from the owner's sign-in.
 */
export async function POST(request: NextRequest) {
  const auditContext = getAuditRequestContext(request);
  try {
    if (!process.env.JWT_SECRET) {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const validation = validateBody(loginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { email, password } = validation.data;

    const settings = await getCachedSettings();
    // With no login at all on the dashboard there is no boundary a tenant sign-in could respect.
    if (settings.requireLogin === false) {
      return NextResponse.json({ error: "Tenant sign-in is unavailable" }, { status: 403 });
    }

    const bruteForce = settings.bruteForceProtection !== false;
    const ip = getLoginLockoutKey(request, auditContext.ipAddress);
    const lockoutKey = `tenant-ip:${ip ?? "unknown"}`;
    const guard = checkLoginGuard(lockoutKey, { enabled: bruteForce });
    if (!guard.allowed) {
      logAuditEvent({
        action: "tenant.login.locked",
        actor: "anonymous",
        target: "tenant-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guard.retryAfterSeconds || 0 },
      });
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(guard.retryAfterSeconds || 60) } }
      );
    }

    const user = getTenantUserAuthByEmail(email);
    const tenant = user ? getTenant(user.tenantId) : null;
    const hash = user?.passwordHash ?? (await dummy());
    const passwordOk = await verifyManagementPassword(password, hash);
    const usable = Boolean(
      user && user.passwordHash && !user.disabled && tenant && !tenant.disabled
    );

    if (!passwordOk || !usable || !user) {
      const failure = recordLoginFailure(lockoutKey, { enabled: bruteForce });
      logAuditEvent({
        action: "tenant.login.failed",
        actor: "anonymous",
        target: "tenant-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { lockedOut: failure.allowed === false, lockoutLevel: failure.level ?? null },
      });
      if (!failure.allowed) {
        return NextResponse.json(
          { error: "Too many failed attempts. Try again later." },
          { status: 429, headers: { "Retry-After": String(failure.retryAfterSeconds || 60) } }
        );
      }
      return NextResponse.json(INVALID, { status: 401 });
    }

    // Second factor: the password only earns a challenge. Counters are cleared only after it.
    if (isMfaEnabled(`user:${user.id}`)) {
      const mfaToken = await mintMfaChallenge(getDashboardJwtSecret()!, `user:${user.id}`);
      return NextResponse.json({ mfaRequired: true, mfaToken });
    }

    const secure = await setTenantSessionCookie(request, user);
    touchTenantUserLogin(user.id);
    clearLoginAttempts(lockoutKey);
    logAuditEvent({
      action: "tenant.login.success",
      actor: `tenant:${tenant!.slug}/${user.email}`,
      target: "tenant-auth",
      resourceType: "auth_session",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { tenantId: tenant!.id, role: user.role, secureCookie: secure },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AUTH] Tenant sign-in failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
