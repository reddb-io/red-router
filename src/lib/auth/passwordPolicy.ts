// The rules a new dashboard password has to meet, and the optional breach screening. The policy is
// local and always on; the breach check asks the Have I Been Pwned range API with a k-anonymity
// prefix (the first five hex characters of the SHA-1, never the password), is opt-in, and fails
// open: an unreachable service never blocks a password change.

import { createHash } from "node:crypto";
import { isKnownInsecureManagementPassword } from "@/lib/auth/managementPassword";

export const MIN_MANAGEMENT_PASSWORD_LENGTH = 8;
export const MAX_MANAGEMENT_PASSWORD_LENGTH = 200;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwertyuiop",
  "iloveyou",
  "admin123",
  "letmein1",
  "welcome1",
  "changeme",
]);

export type PasswordPolicyFailure = "too_short" | "too_long" | "too_common" | "repetitive";

export function checkPasswordPolicy(candidate: string): PasswordPolicyFailure | null {
  if (candidate.length < MIN_MANAGEMENT_PASSWORD_LENGTH) return "too_short";
  if (candidate.length > MAX_MANAGEMENT_PASSWORD_LENGTH) return "too_long";
  if (isKnownInsecureManagementPassword(candidate)) return "too_common";
  if (COMMON_PASSWORDS.has(candidate.toLowerCase())) return "too_common";
  if (new Set(candidate).size === 1) return "repetitive";
  return null;
}

export const PASSWORD_POLICY_MESSAGES: Record<PasswordPolicyFailure, string> = {
  too_short: `Use at least ${MIN_MANAGEMENT_PASSWORD_LENGTH} characters.`,
  too_long: `Use at most ${MAX_MANAGEMENT_PASSWORD_LENGTH} characters.`,
  too_common: "That password is too common. Choose a less guessable one.",
  repetitive: "That password repeats a single character. Choose a less guessable one.",
};

const RANGE_URL = "https://api.pwnedpasswords.com/range/";

/**
 * How many times the password appears in known breaches, or null when the service could not be
 * asked. Only a five-character hash prefix leaves the machine.
 */
export async function breachCount(
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await fetchImpl(`${RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "RedRouter-password-check" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    for (const line of (await response.text()).split(/\r?\n/)) {
      const [candidate, count] = line.trim().split(":");
      if (candidate === suffix) return Number.parseInt(count ?? "0", 10) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}
