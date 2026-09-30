/**
 * Persisted configuration of the Cloudflare Named Tunnel: the Zero Trust tunnel token (a secret)
 * and the public hostname the operator mapped to this router.
 *
 * Storage mirrors `metricsToken.ts`: the token goes through `encrypt()` (AES-256-GCM when
 * STORAGE_ENCRYPTION_KEY is configured, like every other credential at rest) and both keys start
 * with `_`, which `getSettings()` skips, so neither can leak through GET /api/settings, PATCH
 * responses or settings audit diffs. The token is only readable through `readNamedTunnelToken()`,
 * which the tunnel runner calls to hand it to the child process environment. It is never returned
 * by any route.
 */

import { getDbInstance } from "./core";
import { decrypt, encrypt } from "./encryption";

const TOKEN_KEY = "_cloudflaredNamedTunnelToken";
const HOSTNAME_KEY = "_cloudflaredNamedTunnelHostname";

function readRaw(key: string): string {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(key) as { value?: unknown } | undefined;
  if (!row || typeof row.value !== "string") return "";
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
}

function writeRaw(key: string, value: string): void {
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)")
    .run(key, JSON.stringify(value));
}

function deleteRaw(key: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'settings' AND key = ?")
    .run(key);
}

/** Decrypted token, or "" when none is stored. Callers must never log or return it. */
export function readNamedTunnelToken(): string {
  const stored = readRaw(TOKEN_KEY);
  if (!stored) return "";
  try {
    return decrypt(stored) ?? "";
  } catch {
    return "";
  }
}

export function hasNamedTunnelToken(): boolean {
  return readNamedTunnelToken().length > 0;
}

export function readNamedTunnelHostname(): string {
  return readRaw(HOSTNAME_KEY);
}

/** Save the hostname and, when given, replace the token. An omitted token keeps the stored one. */
export function saveNamedTunnelConfig(input: { hostname: string; token?: string }): void {
  const db = getDbInstance();
  db.transaction(() => {
    if (input.token) writeRaw(TOKEN_KEY, encrypt(input.token) as string);
    writeRaw(HOSTNAME_KEY, input.hostname);
  })();
}

export function clearNamedTunnelConfig(): void {
  const db = getDbInstance();
  db.transaction(() => {
    deleteRaw(TOKEN_KEY);
    deleteRaw(HOSTNAME_KEY);
  })();
}
