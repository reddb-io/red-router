import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  TENANT_SESSION_COOKIE,
  TENANT_SESSION_MAX_AGE_SECONDS,
  mintTenantSessionToken,
} from "@/lib/auth/tenantSession";
import type { TenantUserAuth } from "@/lib/db/tenantAuth";

type CookieStore = {
  set: (name: string, value: string, options: Record<string, unknown>) => unknown;
  delete?: (name: string) => unknown;
};

/** Test seam: route handlers run outside a Next request scope in unit tests. */
export const tenantCookieInternals = {
  getCookieStore: cookies as unknown as () => Promise<CookieStore> | CookieStore,
};

function isSecureRequest(request: NextRequest): boolean {
  const forwarded = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return (
    process.env.AUTH_COOKIE_SECURE === "true" ||
    forwarded === "https" ||
    request.nextUrl?.protocol === "https:"
  );
}

/** Signs the user in: mints the tenant session and sets its cookie. Returns whether it is Secure. */
export async function setTenantSessionCookie(
  request: NextRequest,
  user: Pick<TenantUserAuth, "id" | "tenantId" | "sessionVersion">
): Promise<boolean> {
  const secure = isSecureRequest(request);
  const token = await mintTenantSessionToken({
    userId: user.id,
    tenantId: user.tenantId,
    sessionVersion: user.sessionVersion,
  });
  const store = await tenantCookieInternals.getCookieStore();
  store.set(TENANT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: TENANT_SESSION_MAX_AGE_SECONDS,
  });
  return secure;
}

export async function clearTenantSessionCookie(): Promise<void> {
  const store = await tenantCookieInternals.getCookieStore();
  store.set(TENANT_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}
