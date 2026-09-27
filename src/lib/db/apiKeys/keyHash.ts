import { createHash } from "crypto";

export async function hashKey(key: string): Promise<string> {
  if (!key || typeof key !== "string") return "";
  // CodeQL: This is intentionally SHA-256, NOT password hashing. API keys are
  // high-entropy random tokens (not user-chosen passwords) and need fast O(1)
  // comparison for per-request validation. bcrypt/scrypt would add ~100ms per
  // request, which is unacceptable for an API proxy.
  // lgtm[js/insufficient-password-hash]
  return createHash("sha256").update(key).digest("hex"); // nosemgrep: insufficient-password-hash
}
