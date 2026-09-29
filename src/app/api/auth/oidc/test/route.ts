import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSettings } from "@/lib/db/settings";

export const dynamic = "force-dynamic";

interface Check {
  name: "configuration" | "discovery" | "endpoints" | "client";
  ok: boolean;
  detail: string;
}

/**
 * POST /api/auth/oidc/test
 * Checks the saved OIDC configuration without signing anyone in: the identity provider's
 * discovery document, the endpoints the login needs, and that the client id and secret are
 * accepted by the token endpoint (a deliberately bogus authorization code: `invalid_grant` means
 * the client authenticated, `invalid_client` means it did not). Only the issuer the admin already
 * saved is contacted, and every detail is a fixed sentence — nothing from the provider is echoed.
 * A real sign-in check is `GET /api/auth/oidc/login?test=1`.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const settings = await getSettings();
  const issuer = typeof settings.oidcIssuer === "string" ? settings.oidcIssuer.trim() : "";
  const clientId = typeof settings.oidcClientId === "string" ? settings.oidcClientId.trim() : "";
  const clientSecret =
    typeof settings.oidcClientSecret === "string" ? settings.oidcClientSecret.trim() : "";
  const checks: Check[] = [];

  const configured = Boolean(issuer && clientId && clientSecret);
  checks.push({
    name: "configuration",
    ok: configured,
    detail: configured
      ? "Issuer, client id and client secret are set."
      : "Set the issuer, client id and client secret first.",
  });
  if (!configured) return NextResponse.json({ ok: false, checks });

  let metadata: Record<string, unknown> | null = null;
  try {
    const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data: unknown = await response.json();
      if (data && typeof data === "object") metadata = data as Record<string, unknown>;
    }
  } catch {
    // reported below
  }
  checks.push({
    name: "discovery",
    ok: Boolean(metadata),
    detail: metadata
      ? "The discovery document was found."
      : "The discovery document could not be read from the issuer.",
  });
  if (!metadata) return NextResponse.json({ ok: false, checks });

  const authorizationEndpoint = metadata.authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  const jwksUri = metadata.jwks_uri;
  const hasEndpoints = [authorizationEndpoint, tokenEndpoint, jwksUri].every(
    (value) => typeof value === "string" && value.length > 0
  );
  checks.push({
    name: "endpoints",
    ok: hasEndpoints,
    detail: hasEndpoints
      ? "Authorization, token and key endpoints are published."
      : "The discovery document is missing the authorization, token or key endpoint.",
  });
  if (!hasEndpoints) return NextResponse.json({ ok: false, checks });

  let clientOk = false;
  let clientDetail = "The token endpoint could not be reached.";
  try {
    const probe = await fetch(tokenEndpoint as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "redrouter-connection-test",
        redirect_uri: "http://localhost/redrouter-connection-test",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const body: unknown = await probe.json().catch(() => null);
    const error =
      body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
    if (error === "invalid_client" || error === "unauthorized_client") {
      clientDetail = "The identity provider rejected the client id or secret.";
    } else if (probe.status >= 500) {
      clientDetail = "The identity provider had a server error.";
    } else {
      clientOk = true;
      clientDetail = "The identity provider accepted the client id and secret.";
    }
  } catch {
    // keep the default detail
  }
  checks.push({ name: "client", ok: clientOk, detail: clientDetail });

  return NextResponse.json({ ok: checks.every((check) => check.ok), checks });
}
