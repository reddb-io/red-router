import { getDbInstance } from "../core";
import { deleteLKGPByComboName } from "../settings/lkgp";
import { clearRotationState } from "../proxies/rotation";
import { bumpProxyRegistryGeneration } from "../proxies/registryGeneration";
import { RoutingStorageError } from "./routingStorageConfig";

/** Tenant ownership/sharing is still SQLite-shaped. Refuse a mixed authority
 * as soon as a non-default tenant exists, including after a runtime change.
 */
export function assertExternalRoutingLocalScope(): void {
  try {
    if (getDbInstance().prepare("SELECT id FROM tenants WHERE id != ? LIMIT 1").get("red")) {
      throw new RoutingStorageError("unsupported_operation");
    }
  } catch (error) {
    if (error instanceof RoutingStorageError) throw error;
    throw new RoutingStorageError("unavailable");
  }
}

export async function purgeLocalComboState(id: string, name: string): Promise<void> {
  const db = getDbInstance();
  const purge = db.transaction(() => {
    const result = db
      .prepare("DELETE FROM proxy_assignments WHERE scope = 'combo' AND scope_id = ?")
      .run(id);
    clearRotationState(db, "combo", id);
    return result.changes;
  });
  if (purge() > 0) bumpProxyRegistryGeneration();
  if (name) await deleteLKGPByComboName(name);
}
