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
    .prepare<{ value: string }>("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, apiKeyId);
  if (!row) return [];
  try {
    const tags: unknown = JSON.parse(row.value);
    return snapshotApiKeyTags(tags as string[]) ?? [];
  } catch {
    return [];
  }
}

export function deleteApiKeyTags(apiKeyId: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, apiKeyId);
}
