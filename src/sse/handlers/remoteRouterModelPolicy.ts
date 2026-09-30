import { getActiveSyncedCatalog } from "@/lib/db/models/activeSyncedCatalog";
import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy";

/** Remote decision metadata is authoritative even when the downstream ID is opaque. */
export async function isRemoteDecisionRoute(provider: string, model: string): Promise<boolean> {
  if (provider !== "red-router") return false;
  const catalog = await getActiveSyncedCatalog(provider, false);
  const entry = catalog.models.find((entry) => entry.id === model);
  return Boolean(
    entry &&
    getModelEndpointDecision(provider, model, entry.supportedEndpoints).kind === "systemone"
  );
}
