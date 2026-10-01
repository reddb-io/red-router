import { getProviderConnections } from "@/lib/db/providers";
import { readRemoteRouterCatalog } from "@/lib/db/remoteRouterCatalog";
import {
  remoteRouterSnapshot,
  isRemoteDecisionModel,
} from "@/lib/providerModels/remoteRouterCatalog";
import { getAllSystemOneModels } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { resolveSystemOneTarget } from "@omniroute/open-sse/handlers/systemOneCore.ts";

export interface CacheVerificationConnectionOption {
  id: string;
  name: string;
  provider: string;
  models: { id: string; name: string }[];
}

/** Stored, connection-bound decision catalogs only. No credentials leave this helper. */
export async function getCacheVerificationOptions(): Promise<CacheVerificationConnectionOption[]> {
  const connections = await getProviderConnections();
  const registry = getAllSystemOneModels();
  return connections
    .filter((connection) => connection.isActive !== false)
    .map((connection) => {
      let models = registry
        .filter((model) => model.provider === connection.provider)
        .map(({ id, name }) => ({ id, name }));
      if (connection.provider === "red-router") {
        try {
          models = (readRemoteRouterCatalog(remoteRouterSnapshot(connection))?.models ?? [])
            .filter(isRemoteDecisionModel)
            .map((model) => ({ id: `red/${model.id}`, name: model.name || model.id }));
        } catch {
          models = [];
        }
      }
      return {
        id: connection.id,
        name: connection.name || connection.provider,
        provider: connection.provider,
        models: models.filter((model) => resolveSystemOneTarget(model.id) !== null),
      };
    })
    .filter((connection) => connection.models.length > 0);
}
