import { z } from "zod";

// Flat, bounded conditions on verified ID-token claims. Every configured claim
// must match; values within one condition are alternatives.
export const oidcRequiredClaimsSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(
      (key) => !["constructor", "prototype", "__proto__"].includes(key)
    ),
    z.array(z.string().trim().min(1).max(200)).min(1).max(16)
  )
  .refine((conditions) => Object.keys(conditions).length <= 16);

export function hasOidcAccessPolicy(settings: Record<string, unknown>): boolean {
  const claims = oidcRequiredClaimsSchema.safeParse(settings.oidcRequiredClaims ?? {});
  if (!claims.success) return false;
  const subjects = settings.oidcAllowedSubjects;
  return Object.keys(claims.data).length > 0 ||
    (Array.isArray(subjects) && subjects.some((value) => typeof value === "string" && value.trim().length > 0));
}

/** Call only after issuer, audience, signature and nonce verification. */
export function matchesOidcRequiredClaims(policy: unknown, claims: Record<string, unknown>): boolean {
  const parsed = oidcRequiredClaimsSchema.safeParse(policy ?? {});
  if (!parsed.success) return false;
  return Object.entries(parsed.data).every(([name, allowed]) => {
    const actual = claims[name];
    if (typeof actual === "string") return allowed.includes(actual);
    return Array.isArray(actual) && actual.some((value) => typeof value === "string" && allowed.includes(value));
  });
}
