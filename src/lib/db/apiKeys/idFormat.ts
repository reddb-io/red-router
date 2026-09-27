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
    .prepare<{ value: string }>("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, apiKeyId);
  return row?.value === "flat" ? "flat" : "prefixed";
}

export function deleteApiKeyModelIdFormat(apiKeyId: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, apiKeyId);
}
