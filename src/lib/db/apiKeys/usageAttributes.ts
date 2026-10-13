import { getDbInstance } from "../core";
import {
  instanceUsageAttributes,
  snapshotUsageAttributes,
  usageAttributesSchema,
  type UsageAttributes,
} from "@/lib/usage/reportingAttributes";

const NAMESPACE = "api_key_usage_attributes";

/** Called inside the transaction that creates the bearer key. Immutable per key. */
export function insertInitialUsageAttributes(apiKeyId: string, attributes: UsageAttributes): void {
  getDbInstance()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(NAMESPACE, apiKeyId, JSON.stringify(snapshotUsageAttributes(attributes)));
}

/** Snapshot before queuing the ledger event; later environment/key edits cannot alter it. */
export function usageAttributesForKey(apiKeyId: string): UsageAttributes {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, apiKeyId) as { value: string } | undefined;
  const key = row ? usageAttributesSchema.parse(JSON.parse(row.value)) : {};
  const instance = instanceUsageAttributes();
  for (const [name, value] of Object.entries(key)) {
    if (Object.hasOwn(instance, name) && instance[name] !== value) {
      throw new Error("Stored usage attributes conflict with instance attributes");
    }
  }
  return usageAttributesSchema.parse({ ...key, ...instance });
}
