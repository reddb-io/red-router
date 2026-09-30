import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getCachedSettings } from "@/lib/db/settings";
import { verifyMfaProof } from "@/lib/db/mfa";
import {
  sessionCookieInternals,
  setDashboardSessionCookie,
} from "@/lib/auth/dashboardSessionCookie";
import { spendMfaChallenge, verifyMfaChallenge } from "@/lib/auth/mfaChallenge";
import { getDashboardJwtSecret } from "@/shared/utils/dashboardSessionToken";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";
import { getLoginLockoutKey, getLoginSourceScope } from "@/server/auth/loginPeer";
import { getTenant } from "@/lib/db/tenants";
import { getTenantUserAuthById, touchTenantUserLogin } from "@/lib/db/tenantAuth";
import { setTenantSessionCookie } from "@/lib/auth/tenantSessionCookie";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const verifySchema = z.object({
  mfaToken: z.string().min(1).max(2048),
  code: z.string().trim().max(16).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
});

/**
 * POST /api/auth/mfa/verify — the second step of a password sign-in. Public by exact path: the
 * caller has no session yet; the challenge token from /api/auth/login is what authorizes the try.
 * Failures count against the same lockout as password failures.
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
    const validation = validateBody(verifySchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { mfaToken, code, recoveryCode } = validation.data;

    const settings = await getCachedSettings();
    const bruteForceEnabled = settings.bruteForceProtection !== false;

    // The challenge says whose second factor this is. Check it first so the lockout bucket matches
    // the sign-in it belongs to: tenant users have their own, apart from the owner's.
    const challenge = await verifyMfaChallenge(mfaToken, getDashboardJwtSecret());
    if (!challenge) {
      return NextResponse.json(
        { error: "This sign-in expired. Enter your password again.", restart: true },
        { status: 401 }
      );
    }
    const tenantUserId = challenge.principal.startsWith("user:")
      ? challenge.principal.slice("user:".length)
      : null;

    const ip = getLoginLockoutKey(request, auditContext.ipAddress);
    const lockoutKey = tenantUserId ? `tenant-ip:${ip ?? "unknown"}` : ip;
    const guard = checkLoginGuard(lockoutKey, { enabled: bruteForceEnabled });
    if (!guard.allowed) {
      logAuditEvent({
        action: "auth.login.locked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guard.retryAfterSeconds || 0, step: "mfa" },
      });
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(guard.retryAfterSeconds || 60) } }
      );
    }

    const method = verifyMfaProof(challenge.principal, { code, recoveryCode });
    if (!method) {
      const failure = recordLoginFailure(lockoutKey, { enabled: bruteForceEnabled });
      logAuditEvent({
        action: "auth.mfa.failed",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          lockedOut: failure.allowed === false,
          lockoutLevel: failure.level ?? null,
          sourceScope: getLoginSourceScope(request, auditContext.ipAddress),
        },
      });
      if (!failure.allowed) {
        return NextResponse.json(
          { error: "Too many failed attempts. Try again later." },
          { status: 429, headers: { "Retry-After": String(failure.retryAfterSeconds || 60) } }
        );
      }
      return NextResponse.json({ error: "Invalid code" }, { status: 401 });
    }

    // A tenant user: sign in to the tenant, never to the dashboard.
    if (tenantUserId) {
      const user = getTenantUserAuthById(tenantUserId);
      const tenant = user ? getTenant(user.tenantId) : null;
      if (!user || user.disabled || !tenant || tenant.disabled) {
        return NextResponse.json({ error: "Invalid code" }, { status: 401 });
      }
      spendMfaChallenge(challenge);
      const secureCookie = await setTenantSessionCookie(request, user);
      touchTenantUserLogin(user.id);
      clearLoginAttempts(lockoutKey);
      logAuditEvent({
        action: "tenant.login.success",
        actor: `tenant:${tenant.slug}/${user.email}`,
        target: "tenant-auth",
        resourceType: "auth_session",
        status: "success",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { tenantId: tenant.id, role: user.role, secureCookie, mfa: method },
      });
      return NextResponse.json({ success: true, method });
    }

    spendMfaChallenge(challenge);
    const cookieStore = await sessionCookieInternals.getCookieStore();
    const secureCookie = await setDashboardSessionCookie(request, cookieStore);
    clearLoginAttempts(lockoutKey);
    logAuditEvent({
      action: "auth.login.success",
      actor: "owner",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { secureCookie, mfa: method },
    });
    return NextResponse.json({ success: true, method });
  } catch (error) {
    console.error("[AUTH] MFA verification failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
