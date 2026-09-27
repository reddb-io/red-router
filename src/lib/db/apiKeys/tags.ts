import { getDbInstance } from "../core";

const NAMESPACE = "api_key_tags";
const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 20;

/** Copy caller input before asynchronous bearer generation and reject malformed tags. */
export function snapshotApiKeyTags(input?: readonly string[]): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || !input.every((tag) => typeof tag === "string")) {
    throw new Error("API key tags must be an array of strings");
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    tags.push(tag);
    seen.add(tag.toLowerCase());
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** The caller owns the SQLite transaction that inserts the bearer key. */
export function insertInitialApiKeyTagsInTransaction(apiKeyId: string, tags: readonly string[]) {
  if (tags.length === 0) return;
  getDbInstance()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, apiKeyId, JSON.stringify(tags));
}

export function getApiKeyTags(apiKeyId: string): string[] {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, apiKeyId) as { value: string } | undefined;
  return row ? parseStoredTags(row.value) : [];
}

function parseStoredTags(value: string): string[] {
  try {
    const tags: unknown = JSON.parse(value);
    return snapshotApiKeyTags(tags as string[]) ?? [];
  } catch {
    return [];
  }
}

/** Bounded IN queries avoid one SQLite round-trip per key in management listings. */
export function getApiKeyTagsMany(apiKeyIds: readonly string[]): Map<string, string[]> {
  const result = new Map(apiKeyIds.map((id) => [id, [] as string[]]));
  if (apiKeyIds.length === 0) return result;
  const db = getDbInstance();
  for (let offset = 0; offset < apiKeyIds.length; offset += 400) {
    const chunk = apiKeyIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT key, value FROM key_value WHERE namespace = ? AND key IN (${placeholders})`)
      .all(NAMESPACE, ...chunk) as Array<{ key: string; value: string }>;
    for (const row of rows) result.set(row.key, parseStoredTags(row.value));
  }
  return result;
}

export function deleteApiKeyTags(apiKeyId: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, apiKeyId);
}
