/**
 * Tenant sessions: what a signed-in tenant admin or user carries.
 *
 * Deliberately NOT the dashboard session:
 *  - its own cookie (`rr_tenant`);
 *  - signed with a key derived from the instance secret with a distinct label, so a token of one kind
 *    never verifies as the other even if a claim were forged;
 *  - no `authenticated` claim, so `verifyDashboardSessionToken` rejects it;
 *  - the token is a reference, not authority: the user, the tenant and the role are loaded from the
 *    database on every request, and the token's `sv` must match the user's session version.
 */

import { hkdfSync } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getTenant } from "@/lib/db/tenants";
import { getTenantUserAuthById } from "@/lib/db/tenantAuth";

export const TENANT_SESSION_COOKIE = "rr_tenant";
export const TENANT_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const TOKEN_TYPE = "tenant-session";

export type TenantRole = "admin" | "user";

export interface TenantContext {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  email: string;
  role: TenantRole;
}

function tenantSessionKey(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) return null;
  return new Uint8Array(hkdfSync("sha256", secret, "redrouter", "redrouter-tenant-session-v1", 32));
}

export async function mintTenantSessionToken(input: {
  userId: string;
  tenantId: string;
  sessionVersion: number;
}): Promise<string> {
  const key = tenantSessionKey();
  if (!key) throw new Error("JWT_SECRET is not set");
  return new SignJWT({ typ: TOKEN_TYPE, tid: input.tenantId, sv: input.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${TENANT_SESSION_MAX_AGE_SECONDS}s`)
    .sign(key);
}

/**
 * The tenant context for a token, or null. Fails closed on every doubt: bad signature, wrong
 * type, expired, unknown or disabled user, disabled tenant, tenant mismatch, stale session version.
 */
export async function authenticateTenantToken(
  token: string | null | undefined
): Promise<TenantContext | null> {
  const key = tenantSessionKey();
  if (!token || typeof token !== "string" || !key) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.typ !== TOKEN_TYPE) return null;
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string") return null;
    if (typeof payload.sv !== "number") return null;

    const user = getTenantUserAuthById(payload.sub);
    if (!user || user.disabled) return null;
    if (user.tenantId !== payload.tid) return null;
    if (user.sessionVersion !== payload.sv) return null;
    const tenant = getTenant(user.tenantId);
    if (!tenant || tenant.disabled) return null;

    return {
      userId: user.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      email: user.email,
      role: user.role,
    };
  } catch {
    return null;
  }
}
