/**
 * The short-lived token that carries a password-verified sign-in to its second-factor step.
 *
 * It is signed with the dashboard JWT secret but has NO `authenticated` claim, so
 * `verifyDashboardSessionToken` rejects it: it can never be presented as a session. It lives five
 * minutes and is spent (by `jti`) once the second factor succeeds.
 */

import { SignJWT, jwtVerify } from "jose";

const PURPOSE = "mfa-challenge";
const TTL_SECONDS = 5 * 60;

const spent = new Map<string, number>();

function forgetExpired(nowSeconds: number) {
  for (const [jti, exp] of spent) if (exp <= nowSeconds) spent.delete(jti);
}

export async function mintMfaChallenge(secret: Uint8Array, principal: string): Promise<string> {
  return new SignJWT({ purpose: PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(principal)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret);
}

export interface MfaChallenge {
  principal: string;
  jti: string;
  exp: number;
}

/** The challenge when the token is genuine, unexpired and not yet spent; never throws. */
export async function verifyMfaChallenge(
  token: unknown,
  secret: Uint8Array | null
): Promise<MfaChallenge | null> {
  if (typeof token !== "string" || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (payload.purpose !== PURPOSE || typeof payload.sub !== "string") return null;
    if (typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    forgetExpired(Math.floor(Date.now() / 1000));
    if (spent.has(payload.jti)) return null;
    return { principal: payload.sub, jti: payload.jti, exp: payload.exp };
  } catch {
    return null;
  }
}

export function spendMfaChallenge(challenge: MfaChallenge): void {
  spent.set(challenge.jti, challenge.exp);
}
