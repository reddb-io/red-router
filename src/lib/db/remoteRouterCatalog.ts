import { getDbInstance, rowToCamel } from "./core";
import { decryptConnectionFields } from "./encryption";
import { invalidateDbCache } from "./readCache";
import { normalizeSyncedAvailableModels } from "./models/synced";
import { persistCanonicalSyncedAvailableModels } from "./models/syncedAvailableModelPersistence";
import { finishModelCatalogWriteWithoutBackup } from "./models/modelCatalogWriteSignals";
import {
  remoteRouterSnapshot,
  isRemoteDecisionModel,
  parseRemoteRouterModels,
  type RemoteRouterCache,
  type RemoteRouterSnapshot,
} from "../providerModels/remoteRouterCatalog";

/** Cache identity is bound to both endpoint and credential, never provider-wide. */
export function readRemoteRouterCatalog(snapshot: RemoteRouterSnapshot): RemoteRouterCache | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'remoteRouterCatalog' AND key = ?")
    .get(snapshot.id) as { value: string } | undefined;
  if (!row) return null;
  try {
    const cache = JSON.parse(row.value);
    if (cache.fingerprint !== snapshot.fingerprint || !Number.isFinite(cache.syncedAt)) return null;
    return {
      fingerprint: cache.fingerprint,
      syncedAt: cache.syncedAt,
      models: parseRemoteRouterModels(cache.models),
    };
  } catch {
    return null;
  }
}

/** Commit cache and current-runtime model records together, only for the same credential. */
export function commitRemoteRouterCatalog(
  snapshot: RemoteRouterSnapshot,
  cache: RemoteRouterCache
): boolean {
  const db = getDbInstance();
  const committed = db.transaction(() => {
    const row = db.prepare("SELECT * FROM provider_connections WHERE id = ?").get(snapshot.id);
    if (!row) return false;
    let current: RemoteRouterSnapshot;
    try {
      current = remoteRouterSnapshot(decryptConnectionFields(rowToCamel(row)));
    } catch {
      return false;
    }
    if (current.fingerprint !== snapshot.fingerprint) return false;
    const models = normalizeSyncedAvailableModels(
      cache.models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        source: "imported",
        apiFormat: isRemoteDecisionModel(model) ? "systemone" : "chat-completions",
        supportedEndpoints: isRemoteDecisionModel(model) ? ["systemone", "decisions"] : ["chat"],
        remoteCapabilities: model.capabilities ?? {},
        remoteModelIdentity: model.model_identity,
        inputTokenLimit: model.context_length,
        outputTokenLimit: model.max_output_tokens,
        supportsTools: model.capabilities?.tools ?? model.capabilities?.tool_calling,
        supportsThinking: model.capabilities?.reasoning,
        supportsVision: model.capabilities?.vision ?? model.input_modalities?.includes("image"),
      })),
      "red-router"
    );
    persistCanonicalSyncedAvailableModels(
      `red-router:${snapshot.id}`,
      models,
      normalizeSyncedAvailableModels
    );
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('remoteRouterCatalog', ?, ?)"
    ).run(snapshot.id, JSON.stringify(cache));
    db.prepare("UPDATE provider_connections SET synced_models_at = ? WHERE id = ?").run(
      new Date(cache.syncedAt).toISOString(),
      snapshot.id
    );
    return true;
  })();
  if (committed) invalidateDbCache("connections");
  return committed;
}

/** Called inside the provider update transaction; cached entitlements cannot survive edits. */
export function clearRemoteRouterCatalog(connectionId: string): void {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'remoteRouterCatalog' AND key = ?").run(
    connectionId
  );
  db.prepare("DELETE FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = ?").run(
    `red-router:${connectionId}`
  );
  finishModelCatalogWriteWithoutBackup();
}

/** Clear saved remote discovery for this provider without changing connection settings. */
export function clearRemoteRouterCatalogsForProvider(providerId: string): number {
  const result = getDbInstance()
    .prepare(
      "DELETE FROM key_value WHERE namespace = 'remoteRouterCatalog' AND key IN (SELECT id FROM provider_connections WHERE provider = ?)"
    )
    .run(providerId);
  const removed = Number(result.changes);
  if (removed > 0) finishModelCatalogWriteWithoutBackup();
  return removed;
}
