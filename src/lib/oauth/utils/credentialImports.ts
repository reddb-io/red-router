/**
 * Shared helpers for the credential-import routes under `/api/oauth/`:
 *   - `gitlab/pat`          GitLab Duo Personal Access Token
 *   - `iflow/cookie`        iFlow BXAuth session cookie
 *   - `grok-cli/bulk-import` Grok CLI auth entries
 *
 * Ported from 9router. The routes stay thin; everything that talks to the network or
 * shapes a connection lives here so it can be tested without the Next.js runtime.
 * Nothing in this module logs, returns or throws a credential, an upstream response body
 * or an upstream error message.
 */
import { z } from "zod";

import { createProviderConnection } from "@/lib/db/providers";
import { getProvider } from "@/lib/oauth/providers";
import { buildOAuthConnectionCreatePayload } from "@/lib/oauth/connectionPersistence";
import { normalizeGitLabBaseUrl } from "@/lib/oauth/gitlab";
import { fetchWebhookUrl } from "@/shared/network/webhookFetch";
import { ipVersion, isPrivateHost, normalizeHost } from "@/shared/network/privateHost";
import { isCloudMetadataHost } from "@/shared/network/outboundUrlGuard";
import type { DnsLookup } from "@/shared/network/dnsPinnedFetch";
import { errorResponse } from "@omniroute/open-sse/utils/error";

export const MAX_IMPORT_BODY_BYTES = 1_000_000;
export const MAX_BULK_IMPORT_ITEMS = 100;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_RESPONSE_CHARS = 256 * 1024;

/** A failure a route can turn into a response without ever exposing upstream details. */
export class CredentialImportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CredentialImportError";
    this.status = status;
  }
}

/** Map any failure to a response that carries only a fixed, credential-free message. */
export function importErrorResponse(error: unknown): Response {
  if (error instanceof CredentialImportError) return errorResponse(error.status, error.message);
  return errorResponse(500, "Internal server error");
}

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

/** Read a JSON request body, refusing anything over `maxBytes` before parsing it. */
export async function readCappedJsonBody(
  request: Request,
  maxBytes = MAX_IMPORT_BODY_BYTES
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CredentialImportError(413, "Request body is too large");
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new CredentialImportError(400, "Invalid request body");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new CredentialImportError(413, "Request body is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CredentialImportError(400, "Invalid JSON body");
  }
}

export const gitlabPatSchema = z.object({
  token: z.string().trim().min(1, "Personal Access Token is required").max(512),
  baseUrl: z.string().trim().max(2048).optional(),
});

export const iflowCookieSchema = z.object({
  cookie: z.string().trim().min(1, "Cookie is required").max(8192),
});

export const grokBulkImportSchema = z
  .object({
    items: z.array(z.unknown()).min(1, "No items provided").max(MAX_BULK_IMPORT_ITEMS).optional(),
    // 9router's field name, accepted so existing exports keep working.
    accounts: z
      .array(z.unknown())
      .min(1, "No items provided")
      .max(MAX_BULK_IMPORT_ITEMS)
      .optional(),
  })
  .refine((value) => Boolean(value.items || value.accounts), {
    message: "items is required",
    path: ["items"],
  });

// ---------------------------------------------------------------------------
// GitLab Duo Personal Access Token
// ---------------------------------------------------------------------------

/** Test seams: production leaves both unset so the real resolver + pinned connection run. */
export const gitLabPatNetwork: { lookup?: DnsLookup; fetchImpl?: typeof fetch } = {};

/**
 * A user-supplied GitLab host is an SSRF vector. Require https, no credentials in the URL,
 * a DNS name (no IP literal) and, at connect time, a public resolved address — the DNS
 * check and the pinned connection are done by `fetchWebhookUrl`.
 */
export function resolveGitLabPatBaseUrl(baseUrl?: string): string {
  const normalized = normalizeGitLabBaseUrl(baseUrl);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new CredentialImportError(400, "baseUrl must be a valid https URL");
  }
  if (url.protocol !== "https:") {
    throw new CredentialImportError(400, "baseUrl must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CredentialImportError(400, "baseUrl must not contain credentials or a query string");
  }
  const host = normalizeHost(url.hostname);
  if (
    !host ||
    ipVersion(host) !== 0 ||
    !host.includes(".") ||
    isPrivateHost(host) ||
    isCloudMetadataHost(host)
  ) {
    throw new CredentialImportError(400, "baseUrl must be a public host name");
  }
  // `https://host/prefix` is legitimate for GitLab under a relative URL root.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function importGitLabPersonalAccessToken(input: { token: string; baseUrl?: string }) {
  const base = resolveGitLabPatBaseUrl(input.baseUrl);
  const token = input.token.trim();

  let response: Response;
  try {
    ({ response } = await fetchWebhookUrl(
      `${base}/api/v4/user`,
      { method: "GET", headers: { "Private-Token": token, Accept: "application/json" } },
      {
        allowPrivate: false,
        lookup: gitLabPatNetwork.lookup,
        fetchImpl: gitLabPatNetwork.fetchImpl,
        maxRedirects: 0,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    ));
  } catch {
    // Guard rejection, DNS failure, redirect, timeout, TLS error: all "cannot verify".
    throw new CredentialImportError(502, "Could not reach the GitLab host");
  }

  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => {});
    throw new CredentialImportError(401, "GitLab rejected the Personal Access Token");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new CredentialImportError(502, "GitLab token verification failed");
  }

  let user: Record<string, unknown>;
  try {
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_RESPONSE_CHARS) throw new Error("too large");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    user = parsed as Record<string, unknown>;
  } catch {
    throw new CredentialImportError(502, "GitLab returned an unexpected response");
  }

  const username = optionalString(user.username);
  const name = optionalString(user.name);
  const email = optionalString(user.email) || optionalString(user.public_email);
  if (!username && !email) {
    throw new CredentialImportError(502, "GitLab returned an unexpected response");
  }

  // The gitlab-duo executor reads `accessToken` and sends it as a Bearer credential, which
  // GitLab accepts for a PAT. There is no refresh token and no expiry for a PAT.
  const connection = await createProviderConnection({
    provider: "gitlab-duo",
    authType: "oauth",
    accessToken: token,
    refreshToken: null,
    expiresAt: null,
    email: email || null,
    displayName: name || username || email,
    name: name || username || email,
    testStatus: "active",
    isActive: true,
    providerSpecificData: {
      username,
      email,
      name,
      baseUrl: base,
      authKind: "personal_access_token",
    },
  });

  return {
    id: connection?.id ?? null,
    provider: "gitlab-duo",
    email: email || null,
    displayName: name || username || email,
    baseUrl: base,
  };
}

// ---------------------------------------------------------------------------
// iFlow BXAuth cookie
// ---------------------------------------------------------------------------

const IFLOW_API_KEY_URL = "https://platform.iflow.cn/api/openapi/apikey";
const IFLOW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BXAUTH_PATTERN = /(?:^|;\s*)BXAuth=([^;\s]{1,4096})/;

async function readIflowJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_RESPONSE_CHARS) throw new Error("too large");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new CredentialImportError(502, "iFlow returned an unexpected response");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function iflowCall(init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(IFLOW_API_KEY_URL, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new CredentialImportError(502, "Could not reach iFlow");
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => {});
    throw new CredentialImportError(401, "iFlow rejected the session cookie");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new CredentialImportError(502, "iFlow request failed");
  }
  const result = await readIflowJson(response);
  if (result.success !== true) {
    throw new CredentialImportError(401, "iFlow rejected the session cookie");
  }
  return result;
}

export async function importIflowCookie(input: { cookie: string }) {
  const cookie = input.cookie.trim();
  if (CONTROL_CHARS.test(cookie)) {
    throw new CredentialImportError(400, "Cookie contains invalid characters");
  }
  const bxAuth = cookie.match(BXAUTH_PATTERN)?.[1];
  if (!cookie.includes("BXAuth=") || !bxAuth) {
    throw new CredentialImportError(400, "Cookie must contain a BXAuth field");
  }
  const outgoingCookie = cookie.endsWith(";") ? cookie : `${cookie};`;

  // Step 1: read the existing key's name.
  const info = await iflowCall({
    method: "GET",
    headers: {
      Cookie: outgoingCookie,
      Accept: "application/json, text/plain, */*",
      "User-Agent": IFLOW_USER_AGENT,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  const keyName = optionalString(asRecord(info.data).name);
  if (!keyName) {
    throw new CredentialImportError(502, "iFlow returned an unexpected response");
  }

  // Step 2: refresh the key to obtain a usable API key.
  const refreshed = await iflowCall({
    method: "POST",
    headers: {
      Cookie: outgoingCookie,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": IFLOW_USER_AGENT,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Origin: "https://platform.iflow.cn",
      Referer: "https://platform.iflow.cn/",
    },
    body: JSON.stringify({ name: keyName }),
  });
  const data = asRecord(refreshed.data);
  const apiKey = optionalString(data.apiKey);
  if (!apiKey) {
    throw new CredentialImportError(502, "iFlow returned an unexpected response");
  }
  const connectionName = optionalString(data.name) || keyName;
  const expireTime =
    typeof data.expireTime === "string" || typeof data.expireTime === "number"
      ? data.expireTime
      : null;

  const connection = await createProviderConnection({
    provider: "iflow",
    authType: "cookie",
    name: connectionName,
    email: connectionName,
    apiKey,
    providerSpecificData: {
      // Only the BXAuth cookie is kept, as 9router does.
      cookie: `BXAuth=${bxAuth};`,
      expireTime,
    },
    testStatus: "active",
    isActive: true,
  });

  return {
    id: connection?.id ?? null,
    provider: "iflow",
    name: connectionName,
    expireTime,
  };
}

// ---------------------------------------------------------------------------
// Grok CLI bulk import
// ---------------------------------------------------------------------------

export type GrokBulkItemResult = {
  index: number;
  ok: boolean;
  id?: string;
  email?: string | null;
  error?: string;
};

const MAX_GROK_TOKEN_CHARS = 16 * 1024;

function pickString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Turn one bulk entry into the input `grok-cli`'s `mapTokens()` understands — the same
 * mapper the `import-token` action uses, so email/identity extraction is identical.
 * Accepts a bare JWT string, a token-endpoint style object (snake_case or camelCase), or a
 * whole `~/.grok/auth.json` object.
 */
function toGrokTokenInput(raw: unknown): unknown {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) throw new CredentialImportError(400, "Item is empty");
    return { accessToken: value };
  }
  const item = asRecord(raw);
  if (!Object.keys(item).length) throw new CredentialImportError(400, "Item is not an object");

  const accessToken = pickString(item, "access_token", "accessToken");
  if (accessToken) {
    const expiresIn =
      typeof item.expires_in === "number"
        ? item.expires_in
        : typeof item.expiresIn === "number"
          ? item.expiresIn
          : undefined;
    let ttl = expiresIn;
    if (ttl === undefined) {
      const absolute = pickString(item, "expires_at", "expiresAt");
      const parsed = absolute ? Date.parse(absolute) : NaN;
      if (!Number.isNaN(parsed)) ttl = Math.floor((parsed - Date.now()) / 1000);
    }
    return {
      access_token: accessToken,
      refresh_token: pickString(item, "refresh_token", "refreshToken") ?? undefined,
      id_token: pickString(item, "id_token", "idToken") ?? undefined,
      token_type: pickString(item, "token_type", "tokenType") ?? undefined,
      scope: pickString(item, "scope") ?? undefined,
      ...(ttl !== undefined ? { expires_in: ttl } : {}),
    };
  }
  // Whole auth.json object.
  return { accessToken: item };
}

export async function importGrokCliItems(items: unknown[]) {
  const provider = getProvider("grok-cli");
  const results: GrokBulkItemResult[] = [];
  let success = 0;

  for (let index = 0; index < items.length; index++) {
    try {
      const raw = items[index];
      const tokenInput = toGrokTokenInput(raw);
      const tokenData = provider.mapTokens(tokenInput) as Record<string, any>;
      if (
        typeof tokenData.accessToken !== "string" ||
        !tokenData.accessToken.startsWith("eyJ") ||
        tokenData.accessToken.length > MAX_GROK_TOKEN_CHARS
      ) {
        throw new CredentialImportError(
          400,
          "Missing or invalid Grok access token (a JWT is expected)"
        );
      }
      const explicitEmail = pickString(asRecord(raw), "email");
      if (explicitEmail) {
        tokenData.email = explicitEmail;
        tokenData.providerSpecificData = {
          ...(tokenData.providerSpecificData || {}),
          email: explicitEmail,
        };
      }
      if (!tokenData.name && (tokenData.email || tokenData.displayName)) {
        tokenData.name = tokenData.email || tokenData.displayName;
      }
      const expiresAt = tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null;

      // createProviderConnection upserts an existing oauth connection with the same email.
      const connection = await createProviderConnection(
        buildOAuthConnectionCreatePayload("grok-cli", tokenData, expiresAt)
      );
      success++;
      results.push({
        index,
        ok: true,
        id: connection?.id as string | undefined,
        email: (connection?.email as string | null | undefined) ?? tokenData.email ?? null,
      });
    } catch (error) {
      results.push({
        index,
        ok: false,
        error:
          error instanceof CredentialImportError ? error.message : "Could not import this item",
      });
    }
  }

  return { total: items.length, success, failed: items.length - success, results };
}
