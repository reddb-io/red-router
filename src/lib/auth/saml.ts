// SAML 2.0 service-provider login for the dashboard, on top of @node-saml/node-saml. Ported from
// 9router with its security gaps closed:
//   - a response is accepted only if it answers an AuthnRequest this server sent (the request id is
//     kept in a single-use, expiring store shared by start and ACS — not in a SameSite cookie, which
//     the IdP's cross-site POST would not carry), so IdP-initiated and replayed responses fail;
//   - nothing falls back to a dummy certificate or entry point: an incomplete setup refuses;
//   - the signed assertion's audience is pinned to our issuer;
//   - only e-mails on the operator's allow list are let in (9router opens the dashboard to anyone
//     the IdP authenticates).

import {
  SAML,
  ValidateInResponseTo,
  type CacheItem,
  type CacheProvider,
} from "@node-saml/node-saml";

export const SAML_DEFAULT_ISSUER = "urn:red-router:sp";
/** How long an AuthnRequest may stay unanswered. */
export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60_000;

export interface SamlSettings {
  samlEnabled?: unknown;
  samlEntryPoint?: unknown;
  samlCert?: unknown;
  samlIssuer?: unknown;
  samlBaseUrl?: unknown;
  samlAttributeEmail?: unknown;
  samlAllowedEmails?: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function formatX509Certificate(input: unknown): string {
  const clean = asString(input)
    .replace(/-----(BEGIN|END) CERTIFICATE-----/gi, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return "";
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

export function samlAllowedEmails(settings: SamlSettings): string[] {
  const raw = Array.isArray(settings.samlAllowedEmails) ? settings.samlAllowedEmails : [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Why the SAML setup cannot be used, or null when it is complete. */
export function samlConfigProblem(settings: SamlSettings): string | null {
  const entryPoint = asString(settings.samlEntryPoint);
  if (!entryPoint) return "Set the identity provider's sign-in URL.";
  try {
    const url = new URL(entryPoint);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return "The sign-in URL must use https.";
    }
  } catch {
    return "The sign-in URL is not a valid URL.";
  }
  if (!formatX509Certificate(settings.samlCert)) {
    return "Paste the identity provider's signing certificate.";
  }
  if (samlAllowedEmails(settings).length === 0) {
    return "Add at least one e-mail that may sign in.";
  }
  return null;
}

export function isSamlEnabled(settings: SamlSettings): boolean {
  return settings.samlEnabled === true && samlConfigProblem(settings) === null;
}

export function resolveSamlBaseUrl(request: Request, settings: SamlSettings): string {
  const configured = asString(settings.samlBaseUrl) || asString(process.env.BASE_URL);
  if (configured) return configured.replace(/\/+$/, "");
  // Without a configured public address the request's own origin is used; forwarded-host headers
  // are deliberately ignored so a spoofed header cannot steer where the IdP posts the response.
  return new URL(request.url).origin;
}

export function samlIssuer(settings: SamlSettings): string {
  return asString(settings.samlIssuer) || SAML_DEFAULT_ISSUER;
}

interface PendingRequest {
  value: string;
  expiresAt: number;
  test: boolean;
}

const globalStore = globalThis as { __redRouterSamlRequests?: Map<string, PendingRequest> };
function pendingRequests(): Map<string, PendingRequest> {
  return (globalStore.__redRouterSamlRequests ??= new Map());
}

function prune(now: number) {
  for (const [key, entry] of pendingRequests()) if (entry.expiresAt <= now) pendingRequests().delete(key);
}

/**
 * node-saml keeps the ids of the AuthnRequests it sent here and refuses any response that does
 * not answer one. The store is shared process-wide (start and ACS build separate SAML instances)
 * and every entry is single use.
 */
export class SamlRequestStore implements CacheProvider {
  /** The entry removed by the last successful lookup, so ACS can tell a test flow from a login. */
  consumed: PendingRequest | null = null;

  constructor(private readonly flow: { test: boolean } = { test: false }) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const now = Date.now();
    prune(now);
    pendingRequests().set(key, {
      value,
      expiresAt: now + SAML_REQUEST_TTL_MS,
      test: this.flow.test,
    });
    return { value, createdAt: now };
  }

  async getAsync(key: string): Promise<string | null> {
    const entry = pendingRequests().get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    const entry = pendingRequests().get(key) ?? null;
    pendingRequests().delete(key);
    if (entry) this.consumed = entry;
    return entry?.value ?? null;
  }
}

export function createSaml(
  settings: SamlSettings,
  baseUrl: string,
  store: SamlRequestStore = new SamlRequestStore()
): SAML {
  const problem = samlConfigProblem(settings);
  if (problem) throw new Error(problem);
  const cert = formatX509Certificate(settings.samlCert);
  const issuer = samlIssuer(settings);
  return new SAML({
    entryPoint: asString(settings.samlEntryPoint),
    issuer,
    audience: issuer,
    idpCert: cert,
    callbackUrl: `${baseUrl}/api/auth/saml/acs`,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: store,
    disableRequestedAuthnContext: true,
  });
}

/** The IdP URL to send the browser to, and the request id it will answer. */
export async function buildSamlAuthorizeUrl(
  request: Request,
  settings: SamlSettings,
  flow: { test: boolean } = { test: false }
): Promise<string> {
  const saml = createSaml(settings, resolveSamlBaseUrl(request, settings), new SamlRequestStore(flow));
  return saml.getAuthorizeUrlAsync("", undefined, {});
}

export interface SamlLogin {
  email: string;
  test: boolean;
}

/**
 * Validates the IdP's POST. Throws when the signature, audience, timing or request binding is
 * wrong; returns the e-mail the assertion vouches for otherwise (allow-list is checked by the
 * caller, so a test can report "signed in, but not allowed").
 */
export async function validateSamlResponse(
  request: Request,
  settings: SamlSettings,
  samlResponse: string
): Promise<SamlLogin> {
  const store = new SamlRequestStore();
  const saml = createSaml(settings, resolveSamlBaseUrl(request, settings), store);
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new Error("The response carried no profile.");
  return {
    email: pickSamlEmail(profile as unknown as Record<string, unknown>, settings),
    test: store.consumed?.test === true,
  };
}

export function isSamlEmailAllowed(email: string, settings: SamlSettings): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized !== "" && samlAllowedEmails(settings).includes(normalized);
}

const EMAIL_CLAIMS = [
  "email",
  "emailAddress",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "nameID",
];

function firstString(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

/** The e-mail in an assertion: the operator's configured attribute first, then the usual claims. */
export function pickSamlEmail(profile: Record<string, unknown>, settings: SamlSettings): string {
  const custom = asString(settings.samlAttributeEmail);
  const keys = custom ? [custom, ...EMAIL_CLAIMS] : EMAIL_CLAIMS;
  for (const key of keys) {
    const email = firstString(profile[key]);
    if (email.includes("@")) return email;
  }
  return "";
}

export function generateSamlMetadata(request: Request, settings: SamlSettings): string {
  return createSaml(settings, resolveSamlBaseUrl(request, settings)).generateServiceProviderMetadata(
    null
  );
}
