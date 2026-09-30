import { getDbInstance } from "./core";

/** Called by usage writers; attribution survives later key moves or deletion. */
export function tenantIdForUsageKey(apiKeyId?: string | null): string | null {
  if (!apiKeyId || apiKeyId === "env-key") return "red";
  const row = getDbInstance()
    .prepare("SELECT tenant_id FROM api_keys WHERE id = ?")
    .get(apiKeyId) as { tenant_id: string } | undefined;
  return row?.tenant_id ?? null;
}
