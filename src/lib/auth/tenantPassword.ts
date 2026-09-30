import { checkPasswordPolicy, PASSWORD_POLICY_MESSAGES } from "@/lib/auth/passwordPolicy";

export const MIN_TENANT_PASSWORD_LENGTH = 12;

// Words and runs that make a long password guessable anyway ("password1234", "Welcome2026!").
const GUESSABLE = /(passw[o0]rd|qwerty|letmein|changeme|welcome|admin|123456|abcdef)/i;

/** The reason a tenant password is refused, or null. Stricter than the owner's on purpose. */
export function tenantPasswordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_TENANT_PASSWORD_LENGTH) {
    return `Use at least ${MIN_TENANT_PASSWORD_LENGTH} characters.`;
  }
  const failure = checkPasswordPolicy(password);
  if (failure) return PASSWORD_POLICY_MESSAGES[failure];
  if (GUESSABLE.test(password)) return PASSWORD_POLICY_MESSAGES.too_common;
  return null;
}
