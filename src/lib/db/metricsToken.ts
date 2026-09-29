/**
 * Scrape token for the opt-in Prometheus endpoint (GET /api/metrics).
 *
 * Prometheus scrapers cannot do cookie logins, so the endpoint also accepts
 * `Authorization: Bearer <token>`. The token is minted here, server-side, and shown to the
 * operator exactly once — a client never chooses it.
 *
 * Storage mirrors `oidcClientSecret` (encrypted at rest through `encrypt()`), with one deliberate
 * difference: the key starts with `_`, which `getSettings()` skips. That keeps the plaintext out
 * of every settings read (GET /api/settings, PATCH responses, audit diffs) — the token is only
 * readable through `verifyPrometheusMetricsToken()` below.
 */

import { randomBytes } from "node:crypto";
import { getDbInstance } from "./core";
import { decrypt, encrypt } from "./encryption";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";

const TOKEN_KEY = "_prometheusMetricsToken";
export const PROMETHEUS_TOKEN_PREFIX = "rrm_";

function readStoredToken(): string {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(TOKEN_KEY) as { value?: unknown } | undefined;
  if (!row || typeof row.value !== "string") return "";
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed !== "string" || parsed.length === 0) return "";
    return decrypt(parsed) ?? "";
  } catch {
    return "";
  }
}

/** Whether a scrape token has been generated (never reveals it). */
export function hasPrometheusMetricsToken(): boolean {
  return readStoredToken().length > 0;
}

/** Mint a new token, replacing any previous one, and return the plaintext once. */
export function generatePrometheusMetricsToken(): string {
  const token = `${PROMETHEUS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)")
    .run(TOKEN_KEY, JSON.stringify(encrypt(token)));
  return token;
}

/** Revoke the scrape token; bearer scraping stops working until a new one is generated. */
export function clearPrometheusMetricsToken(): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'settings' AND key = ?")
    .run(TOKEN_KEY);
}

/** Constant-time check of a presented bearer token against the stored one. */
export function verifyPrometheusMetricsToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const stored = readStoredToken();
  if (!stored) return false;
  return timingSafeCompare(candidate, stored);
}
