import { getDbInstance } from "../core";

const NAMESPACE = "api_key_tags";

/** Copy caller input before asynchronous bearer generation and reject malformed tags. */
export function snapshotApiKeyTags(input?: readonly string[]): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || !input.every((tag) => typeof tag === "string")) {
    throw new Error("API key tags must be an array of strings");
  }
  return [...input];
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
    return Array.isArray(tags) && tags.every((tag) => typeof tag === "string") ? tags : [];
  } catch {
    return [];
  }
}

export function deleteApiKeyTags(apiKeyId: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, apiKeyId);
}
