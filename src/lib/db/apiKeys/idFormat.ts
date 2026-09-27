import { getDbInstance } from "../core";

export type ApiKeyModelIdFormat = "prefixed" | "flat";

const NAMESPACE = "api_key_id_format";

export function validateApiKeyModelIdFormat(value: unknown): ApiKeyModelIdFormat {
  if (value === "prefixed" || value === "flat") return value;
  throw new Error("API key model ID format must be prefixed or flat");
}

/** The caller owns the SQLite transaction that inserts the bearer key. */
export function insertInitialApiKeyModelIdFormatInTransaction(
  apiKeyId: string,
  format: ApiKeyModelIdFormat
): void {
  if (format === "prefixed") return;
  getDbInstance()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, apiKeyId, format);
}

export function getApiKeyModelIdFormat(apiKeyId: string): ApiKeyModelIdFormat {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, apiKeyId) as { value: string } | undefined;
  return row?.value === "flat" ? "flat" : "prefixed";
}

export function getApiKeyModelIdFormatsMany(
  apiKeyIds: readonly string[]
): Map<string, ApiKeyModelIdFormat> {
  const result = new Map<string, ApiKeyModelIdFormat>(apiKeyIds.map((id) => [id, "prefixed"]));
  if (apiKeyIds.length === 0) return result;
  const db = getDbInstance();
  for (let offset = 0; offset < apiKeyIds.length; offset += 400) {
    const chunk = apiKeyIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT key, value FROM key_value WHERE namespace = ? AND key IN (${placeholders})`)
      .all(NAMESPACE, ...chunk) as Array<{ key: string; value: string }>;
    for (const row of rows) result.set(row.key, row.value === "flat" ? "flat" : "prefixed");
  }
  return result;
}

export function deleteApiKeyModelIdFormat(apiKeyId: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, apiKeyId);
}
