import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";
import { buildSamlAuthorizeUrl, isSamlEnabled, resolveSamlBaseUrl } from "@/lib/auth/saml";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/saml/start
 * Sends the browser to the identity provider with a fresh AuthnRequest. The request id is kept
 * server-side (single use, expiring), so only a response to this request is accepted later.
 * `?test=1` marks the flow as a test sign-in: only a signed-in admin may start one, and the ACS
 * then reports the result without opening a session.
 */
export async function GET(request: Request) {
  const test = new URL(request.url).searchParams.get("test") === "1";
  if (test && !(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Sign in to test SAML." }, { status: 401 });
  }
  const settings = await getSettings();
  if (!isSamlEnabled(settings)) {
    return NextResponse.redirect(
      new URL("/login?saml_error=not_configured", resolveSamlBaseUrl(request, settings))
    );
  }
  try {
    return NextResponse.redirect(await buildSamlAuthorizeUrl(request, settings, { test }));
  } catch {
    return NextResponse.redirect(
      new URL("/login?saml_error=start_failed", resolveSamlBaseUrl(request, settings))
    );
  }
}
