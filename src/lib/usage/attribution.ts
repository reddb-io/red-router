/**
 * Request attribution — who a request was for, beyond which API key paid.
 *
 * Three values are resolved once per request and carried on the request's key record
 * (`withRequestAttribution`) to the places that write them down or act on them:
 *
 * - `endUser`: the OpenAI `user` body field, else the `x-red-router-end-user` header.
 * - `tags`: the key's stored tags, then body `metadata.tags` (array of strings), then the
 *   comma-separated `x-red-router-tags` header — lowercased, deduped, 32 characters each, 20 max.
 *   The key's own tags come first so a client cannot push them out by flooding the cap.
 * - `sessionId`: the existing `x-omniroute-session-id` header.
 *
 * Everything a client sends is untrusted: control characters are stripped and lengths bounded
 * (`shared/constants/attribution`). Prompt text is never read here, and none of these values may
 * become a metric label (unbounded cardinality) — they go to the ledger, the call log and budget
 * scopes only.
 *
 * @module lib/usage/attribution
 */

import { getApiKeyTags } from "@/lib/db/apiKeys/tags";
import { normalizeEndUser, normalizeTags } from "@/shared/constants/attribution";

export interface RequestAttribution {
  endUser: string | null;
  tags: string[];
  sessionId: string | null;
}

type HeaderSource = { headers?: { get?: (name: string) => string | null } | null } | null;

export const END_USER_HEADER = "x-red-router-end-user";
export const TAGS_HEADER = "x-red-router-tags";
export const SESSION_ID_HEADER = "x-omniroute-session-id";

function header(request: HeaderSource | undefined, name: string): string | null {
  const headers = request?.headers;
  return headers && typeof headers.get === "function" ? headers.get(name) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Tags in `metadata.tags`: only an array is read, and only its string members. */
function bodyTags(body: Record<string, unknown> | null): string[] {
  const tags = asRecord(body?.metadata)?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

// A short memo: tags of a key change rarely, the lookup is a database read on every request.
const KEY_TAGS_TTL_MS = 5_000;
const KEY_TAGS_MAX_ENTRIES = 500;
const keyTagsMemo = new Map<string, { at: number; tags: string[] }>();

function storedKeyTags(keyId: string | null | undefined, now: number): string[] {
  if (!keyId) return [];
  const cached = keyTagsMemo.get(keyId);
  if (cached && now - cached.at < KEY_TAGS_TTL_MS) return cached.tags;
  let tags: string[] = [];
  try {
    tags = getApiKeyTags(keyId);
  } catch {
    // Attribution must never fail a request; a key without readable tags has none.
  }
  if (keyTagsMemo.size >= KEY_TAGS_MAX_ENTRIES) keyTagsMemo.clear();
  keyTagsMemo.set(keyId, { at: now, tags });
  return tags;
}

/** Forget the remembered key tags (tests, and after bulk edits). */
export function resetAttributionCache(): void {
  keyTagsMemo.clear();
}

/**
 * Resolve the attribution of one request. `keyTags` may be passed to skip the (memoised) lookup
 * of the key's stored tags.
 */
export function resolveAttribution(
  request: HeaderSource | undefined,
  body: unknown,
  apiKeyInfo: { id?: string | null } | null | undefined,
  keyTags?: readonly string[]
): RequestAttribution {
  const record = asRecord(body);
  const endUser =
    normalizeEndUser(typeof record?.user === "string" ? record.user : null) ??
    normalizeEndUser(header(request, END_USER_HEADER));
  const headerTags = (header(request, TAGS_HEADER) ?? "").split(",");
  const tags = normalizeTags([
    ...(keyTags ?? storedKeyTags(apiKeyInfo?.id, Date.now())),
    ...bodyTags(record),
    ...headerTags,
  ]);
  const sessionId = normalizeEndUser(header(request, SESSION_ID_HEADER));
  return { endUser, tags, sessionId };
}

// ---------------------------------------------------------------------------
// Carrying the attribution through the request
// ---------------------------------------------------------------------------

/** What the combo gate needs to look a request up without a database read. */
export interface RequestBudgetScope {
  keyId: string;
  attribution: RequestAttribution;
}

// Keyed by the request's lifecycle AbortSignal: the handler and the combo attempt loop share that
// one object for the life of the request (the body object is replaced several times on the way),
// so the per-target gate can find the key and attribution without new plumbing.
const scopeBySignal = new WeakMap<object, RequestBudgetScope>();

/**
 * A per-request copy of the key record that also carries the request's attribution. The
 * original is shared through the metadata cache and must not be mutated. Also registers the
 * request under `signal` for {@link getRequestBudgetScope}. A request without a key is returned
 * unchanged.
 */
export function withRequestAttribution<T extends { id?: string | null } | null | undefined>(
  apiKeyInfo: T,
  request: HeaderSource | undefined,
  body: unknown,
  signal?: AbortSignal | null
): T extends null | undefined ? T : T & { attribution: RequestAttribution } {
  type Result = T extends null | undefined ? T : T & { attribution: RequestAttribution };
  if (!apiKeyInfo?.id) return apiKeyInfo as Result;
  const attribution = resolveAttribution(request, body, apiKeyInfo);
  if (signal) scopeBySignal.set(signal, { keyId: apiKeyInfo.id, attribution });
  return { ...apiKeyInfo, attribution } as Result;
}

export function getRequestBudgetScope(
  signal: object | null | undefined
): RequestBudgetScope | null {
  return signal ? (scopeBySignal.get(signal) ?? null) : null;
}
