import { NextResponse } from "next/server";
import { getCachedSettings } from "@/lib/db/readCache";
import { getSettings, updateSettings } from "@/lib/db/settings";
import {
  isSamlEmailAllowed,
  isSamlEnabled,
  resolveSamlBaseUrl,
  validateSamlResponse,
} from "@/lib/auth/saml";
import {
  getDashboardJwtSecret,
  mintDashboardSessionToken,
} from "@/shared/utils/dashboardSessionToken";
import { getLoginLockoutKey } from "@/server/auth/loginPeer";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";

export const dynamic = "force-dynamic";

/** Keeps a hostile POST from making the XML parser chew on megabytes. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * POST /api/auth/saml/acs
 * The identity provider's assertion consumer endpoint. Every failure redirects to the login page
 * with a fixed code; nothing from the response or the error is echoed. A response is accepted only
 * if it answers an AuthnRequest we sent (see lib/auth/saml.ts) and names an e-mail on the allow
 * list. A test sign-in reports back to Settings and opens no session.
 */
export async function POST(request: Request) {
  const settings = await getCachedSettings();
  const base = resolveSamlBaseUrl(request, settings);
  const fail = (code: string, test = false) =>
    NextResponse.redirect(
      new URL(
        test ? `/dashboard/settings/security?saml_test=${code}` : `/login?saml_error=${code}`,
        base
      ),
      303
    );

  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const lockoutKey = getLoginLockoutKey(request, forwardedIp);
  const guardOn = settings.bruteForceProtection !== false;
  if (!checkLoginGuard(lockoutKey, { enabled: guardOn }).allowed) return fail("locked");

  if (!isSamlEnabled(settings)) return fail("not_configured");

  let samlResponse = "";
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) return fail("invalid_response");
    const form = await request.formData();
    const value = form.get("SAMLResponse");
    samlResponse = typeof value === "string" ? value : "";
  } catch {
    return fail("invalid_response");
  }
  if (!samlResponse || samlResponse.length > MAX_RESPONSE_BYTES) return fail("invalid_response");

  let login;
  try {
    login = await validateSamlResponse(request, settings, samlResponse);
  } catch {
    recordLoginFailure(lockoutKey, { enabled: guardOn });
    return fail("invalid_response");
  }

  if (!isSamlEmailAllowed(login.email, settings)) {
    recordLoginFailure(lockoutKey, { enabled: guardOn });
    return fail("not_allowed", login.test);
  }

  if (login.test) {
    return NextResponse.redirect(new URL("/dashboard/settings/security?saml_test=ok", base), 303);
  }

  const secret = getDashboardJwtSecret();
  if (!secret) return fail("server_misconfigured");

  clearLoginAttempts(lockoutKey);
  try {
    if (!(await getSettings()).setupComplete) await updateSettings({ setupComplete: true });
  } catch {
    // non-fatal — the login can still proceed
  }

  const forwardedProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const secure =
    process.env.AUTH_COOKIE_SECURE === "true" ||
    forwardedProto.toLowerCase() === "https" ||
    base.startsWith("https:");
  const response = NextResponse.redirect(new URL("/dashboard", base), 303);
  response.cookies.set("auth_token", await mintDashboardSessionToken(secret), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
