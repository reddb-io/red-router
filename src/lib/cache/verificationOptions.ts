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
  return connections.flatMap((connection) => {
    const { id, provider, name } = connection;
    if (
      typeof id !== "string" ||
      typeof provider !== "string" ||
      connection.isActive === false ||
      connection.isActive === 0
    )
      return [];
    let models = registry
      .filter((model) => model.provider === provider)
      .map(({ id, name }) => ({ id, name }));
    if (provider === "red-router") {
      try {
        models = (readRemoteRouterCatalog(remoteRouterSnapshot(connection))?.models ?? [])
          .filter(isRemoteDecisionModel)
          .map((model) => ({ id: `red/${model.id}`, name: model.name || model.id }));
      } catch {
        models = [];
      }
    }
    models = models.filter((model) => resolveSystemOneTarget(model.id) !== null);
    return models.length
      ? [{ id, provider, name: typeof name === "string" && name ? name : provider, models }]
      : [];
  });
}
