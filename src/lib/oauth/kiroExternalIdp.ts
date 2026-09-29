/**
 * Normalizes a CLIProxyAPI `type: "kiro"` auth file for an External IdP (enterprise SSO)
 * account into the connection fields RedRouter stores. Ported from 9router's
 * `src/lib/oauth/kiroExternalIdp.js`; the token-endpoint allowlist, scope handling, JWT
 * decoding and email extraction are reused from `open-sse/services/kiroExternalIdp.ts` so an
 * imported connection is refreshable by exactly the code that already handles External IdP.
 */

import {
  KIRO_EXTERNAL_IDP_AUTH_METHOD,
  decodeJwtPayload,
  emailFromExternalIdpToken,
  normalizeScope,
  validateExternalIdpTokenEndpoint,
} from "@omniroute/open-sse/services/kiroExternalIdp.ts";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/** Carries a fixed, credential-free message that is safe to return to a client. */
export class KiroExternalIdpImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KiroExternalIdpImportError";
  }
}

export interface KiroExternalIdpAuth {
  /** Empty when the file carried none; the connection is then already expired and refreshes. */
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  email: string | null;
  providerSpecificData: {
    profileArn: string;
    region: string;
    authMethod: "external_idp";
    provider: "CLIProxyAPI";
    clientId: string;
    tokenEndpoint: string;
    scope: string;
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pick(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = str(input[key]);
    if (value) return value;
  }
  return "";
}

function resolveExpiresAt(
  input: Record<string, unknown>,
  accessToken: string,
  now: number
): string {
  const explicit = input.expired ?? input.expires_at ?? input.expiresAt;
  if (typeof explicit === "string" || typeof explicit === "number") {
    const ms = typeof explicit === "number" ? explicit : Date.parse(explicit);
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms < 1e12 && typeof explicit === "number" ? ms * 1000 : ms).toISOString();
    }
  }
  const expiresIn = Number(input.expires_in ?? input.expiresIn ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(now + expiresIn * 1000).toISOString();
  }
  // Without an access token there is nothing to keep using: mark it expired so the first
  // request refreshes it with the stored refresh token.
  if (!accessToken) return new Date(now).toISOString();
  const exp = Number(decodeJwtPayload(accessToken)?.exp);
  if (Number.isFinite(exp) && exp > 0) return new Date(exp * 1000).toISOString();
  return new Date(now + DEFAULT_EXPIRES_IN_SECONDS * 1000).toISOString();
}

/**
 * Validate and normalize a CLIProxyAPI Kiro `external_idp` auth object (or its JSON text).
 * Throws {@link KiroExternalIdpImportError} with a fixed message; never echoes field values.
 * `access_token` is optional (the refresh token is enough to mint one).
 */
export function normalizeKiroExternalIdpAuth(
  rawAuth: unknown,
  now: number = Date.now()
): KiroExternalIdpAuth {
  let input: unknown = rawAuth;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new KiroExternalIdpImportError("CLIProxyAPI auth JSON is invalid");
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new KiroExternalIdpImportError("CLIProxyAPI auth JSON is required");
  }
  const record = input as Record<string, unknown>;

  if (pick(record, "auth_method", "authMethod").toLowerCase() !== KIRO_EXTERNAL_IDP_AUTH_METHOD) {
    throw new KiroExternalIdpImportError(
      "Only external_idp Kiro auth is supported by this importer"
    );
  }

  const accessToken = pick(record, "access_token", "accessToken");
  const refreshToken = pick(record, "refresh_token", "refreshToken");
  const clientId = pick(record, "client_id", "clientId");
  const profileArn = pick(record, "profile_arn", "profileArn");
  const region = pick(record, "region") || DEFAULT_REGION;
  const scope = normalizeScope(record.scopes ?? record.scope);

  let tokenEndpoint: string;
  try {
    tokenEndpoint = validateExternalIdpTokenEndpoint(record.token_endpoint ?? record.tokenEndpoint);
  } catch {
    throw new KiroExternalIdpImportError(
      "token_endpoint must be an https endpoint of a supported identity provider"
    );
  }

  if (!refreshToken) throw new KiroExternalIdpImportError("refresh_token is required");
  if (!clientId) throw new KiroExternalIdpImportError("client_id is required");
  if (!scope) throw new KiroExternalIdpImportError("scopes is required");
  if (!profileArn) throw new KiroExternalIdpImportError("profile_arn is required");

  return {
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(record, accessToken, now),
    email: str(record.email) || emailFromExternalIdpToken(accessToken),
    providerSpecificData: {
      profileArn,
      region,
      authMethod: KIRO_EXTERNAL_IDP_AUTH_METHOD,
      provider: "CLIProxyAPI",
      clientId,
      tokenEndpoint,
      scope,
    },
  };
}
