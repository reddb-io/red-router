/**
 * Secret handling for destination configs.
 *
 * Which keys are secret is declared by the destination type (`secretFields`), so this
 * module stays generic: encrypt on write, decrypt only when a client is constructed,
 * and redact before anything reaches an API response.
 *
 * The `*SecretFields` primitives take the key list directly. Log export resolves it from
 * its destination registry; RedRouter's usage sinks pass their transport's list, so the
 * encrypt / decrypt / redact / keep-on-edit semantics are defined once.
 */

import { decrypt, encrypt, isEncryptionEnabled } from "@/lib/db/encryption";
import { getLogExportDestinationType } from "./registry";

/** Placeholder returned by the API in place of a stored secret. */
export const SECRET_PLACEHOLDER = "__stored__";

function secretKeysFor(type: string): readonly string[] {
  return getLogExportDestinationType(type)?.secretFields ?? [];
}

/** True when `secretKeys` holds a non-empty value AND field encryption is off. */
export function fieldsRequireEncryptionKey(
  secretKeys: readonly string[],
  config: Record<string, unknown>
): boolean {
  if (isEncryptionEnabled()) return false;
  return secretKeys.some((key) => {
    const value = config[key];
    return typeof value === "string" && value.length > 0;
  });
}

/** Encrypt every listed secret key. Other keys pass through untouched. */
export function encryptSecretFields(
  secretKeys: readonly string[],
  config: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of secretKeys) {
    const value = out[key];
    if (typeof value === "string" && value.length > 0) out[key] = encrypt(value);
  }
  return out;
}

/** Decrypt listed secret keys for runtime use. Never feed the result to a response. */
export function decryptSecretFields(
  secretKeys: readonly string[],
  config: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of secretKeys) {
    const value = out[key];
    if (typeof value === "string" && value.length > 0) out[key] = decrypt(value) ?? "";
  }
  return out;
}

/** Replace listed secrets with SECRET_PLACEHOLDER; an absent secret stays absent. */
export function redactSecretFields(
  secretKeys: readonly string[],
  config: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of secretKeys) {
    const value = out[key];
    if (typeof value === "string" && value.length > 0) out[key] = SECRET_PLACEHOLDER;
    else delete out[key];
  }
  return out;
}

/** Merge incoming over stored, keeping stored ciphertext where the placeholder (or nothing) came back. */
export function mergeSecretFields(
  secretKeys: readonly string[],
  storedConfig: Record<string, unknown>,
  incomingConfig: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incomingConfig };
  for (const key of secretKeys) {
    if (merged[key] === SECRET_PLACEHOLDER || merged[key] === undefined) {
      if (storedConfig[key] !== undefined) merged[key] = storedConfig[key];
      else delete merged[key];
    }
  }
  return merged;
}

/**
 * True when this destination type stores a credential AND field encryption is off.
 *
 * `encrypt()` is a silent passthrough without STORAGE_ENCRYPTION_KEY, which is the
 * default for a fresh install — so writing a service-account key would land it in
 * SQLite as plaintext. Callers refuse the write instead (the same guard the Telegram
 * webhook uses).
 */
export function requiresEncryptionKey(type: string, config: Record<string, unknown>): boolean {
  return fieldsRequireEncryptionKey(secretKeysFor(type), config);
}

/** Encrypt every declared secret key. Non-secret keys pass through untouched. */
export function encryptDestinationConfig(
  type: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  return encryptSecretFields(secretKeysFor(type), config);
}

/** Decrypt declared secret keys for runtime use. Never feed the result to a response. */
export function decryptDestinationConfig(
  type: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  return decryptSecretFields(secretKeysFor(type), config);
}

/**
 * Replace declared secrets with a placeholder for API responses. A stored secret
 * becomes SECRET_PLACEHOLDER; an absent one stays absent, so the UI can tell
 * "configured" from "never set".
 */
export function redactDestinationConfig(
  type: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  return redactSecretFields(secretKeysFor(type), config);
}

/**
 * Merge an incoming config over the stored one, keeping the stored ciphertext wherever
 * the caller sent back the placeholder (an edit that did not retype the secret).
 */
export function mergeDestinationConfig(
  type: string,
  storedConfig: Record<string, unknown>,
  incomingConfig: Record<string, unknown>
): Record<string, unknown> {
  return mergeSecretFields(secretKeysFor(type), storedConfig, incomingConfig);
}
