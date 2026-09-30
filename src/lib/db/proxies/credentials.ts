/**
 * Encryption at rest for the outbound-proxy registry credentials (`proxy_registry.username` and
 * `proxy_registry.password`).
 *
 * Both columns hold secrets: the password is a vendor secret and the username usually carries an
 * account identifier (`brd-customer-<id>-zone-<zone>-session-<sid>`). They go through the same
 * AES-256-GCM helpers as provider connection credentials (`../encryption`), and the boundary is the
 * DB modules: every writer calls `encryptProxyCredentials` and every reader
 * `decryptProxyCredentials`, so callers keep seeing plaintext exactly as before.
 *
 * Compatibility rules:
 * - Legacy plaintext rows stay readable (`decrypt` passes non-prefixed values through) and are
 *   encrypted by the next write or by `encryptExistingProxyCredentials`.
 * - With no STORAGE_ENCRYPTION_KEY configured everything is a passthrough, as before.
 * - A ciphertext that cannot be decrypted (key changed or removed) never throws: the credential
 *   reads as empty, a warning without the value is logged once, and writers that preserve stored
 *   credentials keep the original ciphertext so the right key can still recover it.
 *
 * Encrypted usernames are non-deterministic (random IV), so the registry identity
 * (host + port + username) cannot be matched with SQL equality on `username`; see `upsertProxy`.
 */

import { decrypt, encrypt, isEncryptionEnabled, looksEncrypted } from "../encryption";

type CredentialField = "username" | "password";

const CREDENTIAL_FIELDS: readonly CredentialField[] = ["username", "password"];
const MAX_WARNED = 1000;
const warnedCiphertexts = new Set<string>();

function warnUndecryptable(field: CredentialField, ciphertext: string, rowId?: unknown): void {
  if (warnedCiphertexts.has(ciphertext)) return;
  if (warnedCiphertexts.size >= MAX_WARNED) warnedCiphertexts.clear();
  warnedCiphertexts.add(ciphertext);
  const row = typeof rowId === "string" && rowId ? ` (proxy ${rowId})` : "";
  console.warn(
    `[ProxyRegistry] Cannot decrypt the stored proxy ${field}${row}; using an empty value. ` +
      "Verify STORAGE_ENCRYPTION_KEY matches the key used to store it."
  );
}

/**
 * Decrypt one stored credential. Returns `null` when the value is a ciphertext that cannot be
 * decrypted (missing or different key); plaintext, empty and non-string values never fail.
 */
export function tryDecryptProxyCredential(
  value: unknown,
  field: CredentialField,
  rowId?: unknown
): string | null {
  if (typeof value !== "string" || value === "") return "";
  if (!looksEncrypted(value)) return value;
  if (isEncryptionEnabled()) {
    const plain = decrypt(value, { quiet: true });
    if (typeof plain === "string") return plain;
  }
  warnUndecryptable(field, value, rowId);
  return null;
}

/** Decrypt one stored credential, reading an undecryptable ciphertext as an empty string. */
export function decryptProxyCredential(
  value: unknown,
  field: CredentialField,
  rowId?: unknown
): string {
  return tryDecryptProxyCredential(value, field, rowId) ?? "";
}

/**
 * Encrypt one credential for storage. Empty values and already-encrypted values are returned
 * unchanged, and so is everything when no storage key is configured.
 */
export function encryptProxyCredential(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") return "";
  if (!isEncryptionEnabled() || looksEncrypted(value)) return value;
  const stored = encrypt(value);
  return typeof stored === "string" ? stored : value;
}

/** Return a copy of `row` whose present `username`/`password` fields are encrypted for storage. */
export function encryptProxyCredentials<T extends object>(row: T): T {
  const next = { ...row } as Record<string, unknown>;
  for (const field of CREDENTIAL_FIELDS) {
    if (field in next && typeof next[field] === "string") {
      next[field] = encryptProxyCredential(next[field] as string);
    }
  }
  return next as unknown as T;
}

/** Return a copy of `row` whose present `username`/`password` fields are plaintext again. */
export function decryptProxyCredentials<T extends object>(row: T): T {
  const next = { ...row } as Record<string, unknown>;
  for (const field of CREDENTIAL_FIELDS) {
    if (field in next && typeof next[field] === "string") {
      next[field] = decryptProxyCredential(next[field], field, next.id);
    }
  }
  return next as unknown as T;
}

interface PlaintextCredentialRow {
  id: string;
  username: string | null;
  password: string | null;
}

interface MaintenanceDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): () => T;
}

/**
 * One-shot, idempotent upgrade of legacy plaintext rows: encrypts every stored username/password
 * that is not yet a ciphertext. A no-op when no storage key is configured or every row is already
 * encrypted. `updated_at` is left alone (the plaintext a reader sees does not change).
 * `beforeWrite` runs once, only when there is something to encrypt (used for a safety backup).
 */
export function encryptExistingProxyCredentials(
  db: MaintenanceDb,
  options: { beforeWrite?: () => void } = {}
): { encrypted: number } {
  if (!isEncryptionEnabled()) return { encrypted: 0 };

  const rows = db
    .prepare(
      `SELECT id, username, password FROM proxy_registry
        WHERE (username IS NOT NULL AND username != '' AND substr(username, 1, 7) != 'enc:v1:')
           OR (password IS NOT NULL AND password != '' AND substr(password, 1, 7) != 'enc:v1:')`
    )
    .all() as PlaintextCredentialRow[];
  if (rows.length === 0) return { encrypted: 0 };

  options.beforeWrite?.();
  const update = db.prepare("UPDATE proxy_registry SET username = ?, password = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      update.run(
        encryptProxyCredential(row.username ?? ""),
        encryptProxyCredential(row.password ?? ""),
        row.id
      );
    }
  })();
  return { encrypted: rows.length };
}
