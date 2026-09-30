import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  getDashboardJwtSecret,
  mintDashboardSessionToken,
} from "@/shared/utils/dashboardSessionToken";

/** Test seam: route handlers run outside a Next request scope in unit tests. */
export const sessionCookieInternals = {
  getCookieStore: cookies as () => Promise<CookieStore> | CookieStore,
};

type CookieStore = {
  set: (name: string, value: string, options: Record<string, unknown>) => unknown;
};

/**
 * Mints a dashboard session and sets its cookie. Every sign-in path that ends in a session (password,
 * password + second factor) goes through here so the cookie attributes never diverge.
 * Returns whether the cookie was marked Secure.
 */
export async function setDashboardSessionCookie(
  request: NextRequest,
  cookieStore: CookieStore,
  subject: string = "owner"
): Promise<boolean> {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProtoHeader = request.headers.get("x-forwarded-proto") || "";
  const forwardedProto = forwardedProtoHeader.split(",")[0].trim().toLowerCase();
  const isHttpsRequest = forwardedProto === "https" || request.nextUrl?.protocol === "https:";
  const useSecureCookie = forceSecureCookie || isHttpsRequest;

  const token = await mintDashboardSessionToken(getDashboardJwtSecret()!, subject);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: useSecureCookie,
    sameSite: "lax",
    path: "/",
    // 30 days — bound the cookie lifetime to the JWT's 30d expiry so the browser
    // drops it on the same schedule the token stops being valid (Seg3 hardening).
    maxAge: 60 * 60 * 24 * 30,
  });
  return useSecureCookie;
}
