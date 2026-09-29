import { NextResponse } from "next/server";
import { getCachedSettings } from "@/lib/db/readCache";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  OIDC_FLOW_COOKIE_MAX_AGE_SECONDS,
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_TEST_COOKIE,
  OIDC_VERIFIER_COOKIE,
  createOidcNonce,
  createOidcState,
  createPkcePair,
} from "@/lib/auth/oidcFlow";

/**
 * GET /api/auth/oidc/login
 * Starts OIDC login for the dashboard admin gate.
 * Builds an authorization URL from settings and redirects the browser.
 * Password login remains available as fallback.
 *
 * The request carries PKCE (S256) and a nonce, both bound to this browser through short-lived
 * httpOnly cookies. `?test=1` runs the same flow as a "test sign-in": it is only available to
 * an already signed-in admin, and the callback then reports the result without opening a session.
 */
export async function GET(request: Request) {
  const isTest = new URL(request.url).searchParams.get("test") === "1";
  if (isTest && !(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Sign in to test OIDC." }, { status: 401 });
  }
  const settings = await getCachedSettings();

  const enabled = settings.oidcEnabled === true;
  const rawIssuer = typeof settings.oidcIssuer === "string" ? settings.oidcIssuer.trim() : "";
  const issuerBase = rawIssuer.replace(/\/+$/, "");
  const clientId = typeof settings.oidcClientId === "string" ? settings.oidcClientId.trim() : "";
  const clientSecret =
    typeof settings.oidcClientSecret === "string" ? settings.oidcClientSecret.trim() : "";
  const scopes: string[] =
    Array.isArray(settings.oidcScopes) && settings.oidcScopes.length > 0
      ? settings.oidcScopes.filter((s): s is string => typeof s === "string")
      : ["openid", "profile", "email"];
  const redirectPath =
    typeof settings.oidcRedirectPath === "string" && settings.oidcRedirectPath.length > 0
      ? settings.oidcRedirectPath
      : "/api/auth/oidc/callback";

  if (!enabled || !rawIssuer || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "OIDC is not configured. Use password login or configure OIDC in settings." },
      { status: 400 }
    );
  }

  // Absolute redirect_uri from the incoming request (respects x-forwarded-proto)
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const reqUrl = new URL(request.url);
  const scheme = forwardedProto === "https" || reqUrl.protocol === "https:" ? "https" : "http";
  const host = request.headers.get("host") || request.headers.get("Host") || reqUrl.host;
  const origin = `${scheme}://${host}`;
  const redirectUri = `${origin}${redirectPath}`;

  // Discover authorization_endpoint
  let authEndpoint = `${issuerBase}/authorize`;
  try {
    const wellKnownResp = await fetch(`${issuerBase}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (wellKnownResp.ok) {
      const data: unknown = await wellKnownResp.json();
      if (data && typeof data === "object" && "authorization_endpoint" in data) {
        const candidate = (data as Record<string, unknown>).authorization_endpoint;
        if (typeof candidate === "string" && candidate.length > 0) {
          authEndpoint = candidate;
        }
      }
    }
  } catch {
    // fall back to convention
  }

  const scope = scopes.join(" ");
  const state = createOidcState();
  const nonce = createOidcNonce();
  const pkce = createPkcePair();

  const url = new URL(authEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const isHttpsRequest = scheme === "https";
  const useSecureCookie = process.env.AUTH_COOKIE_SECURE === "true" || isHttpsRequest;

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: OIDC_FLOW_COOKIE_MAX_AGE_SECONDS,
    secure: useSecureCookie,
  };
  const res = NextResponse.redirect(url.toString());
  res.cookies.set(OIDC_STATE_COOKIE, state, cookieOptions);
  res.cookies.set(OIDC_NONCE_COOKIE, nonce, cookieOptions);
  res.cookies.set(OIDC_VERIFIER_COOKIE, pkce.verifier, cookieOptions);
  if (isTest) res.cookies.set(OIDC_TEST_COOKIE, "1", cookieOptions);
  return res;
}
