// Small pure helpers for the dashboard's OIDC login: PKCE (RFC 7636, S256), the nonce that binds
// the ID token to the browser that started the flow, and random state. Kept apart from the routes
// so they are unit-testable and shared by the login, callback and test routes.

import { createHash, randomBytes } from "node:crypto";

export const OIDC_STATE_COOKIE = "oidc_state";
export const OIDC_NONCE_COOKIE = "oidc_nonce";
export const OIDC_VERIFIER_COOKIE = "oidc_code_verifier";
export const OIDC_TEST_COOKIE = "oidc_test";
/** The flow cookies live for the length of a login attempt, not longer. */
export const OIDC_FLOW_COOKIE_MAX_AGE_SECONDS = 60 * 10;
/** Settings key stamped when a test sign-in succeeded; cleared when the OIDC configuration changes. */
export const OIDC_LAST_TEST_SETTING = "oidcLastTestSucceededAt";

/** Settings that, when changed, make an earlier successful test sign-in stale. */
export const OIDC_CONFIG_KEYS = [
  "oidcIssuer",
  "oidcClientId",
  "oidcClientSecret",
  "oidcScopes",
  "oidcRedirectPath",
  "oidcAllowedSubjects",
] as const;

const b64url = (buffer: Buffer): string => buffer.toString("base64url");

export function createOidcState(): string {
  return b64url(randomBytes(24));
}

export function createOidcNonce(): string {
  return b64url(randomBytes(24));
}

export function createPkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes -> a 43 character verifier, the RFC 7636 minimum.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

export function pkceChallengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}
