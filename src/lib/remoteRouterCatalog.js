import { getProviderConnectionById, updateProviderConnection } from "@/models";
import { redRouterEndpoint } from "open-sse/config/redRouter.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const REFRESH_MS = 5 * 60 * 1000;

// Store per connection: different remote keys can expose different catalogs.
export async function syncRemoteRouterCatalog(connection, { force = false, persist = true } = {}) {
  const data = connection.providerSpecificData || {};
  const cached = Array.isArray(data.discoveredModels) ? data.discoveredModels : [];
  if (!force && data.modelsSyncedAt && Date.now() - Date.parse(data.modelsSyncedAt) < REFRESH_MS) {
    return { models: cached };
  }
  try {
    if (!data.baseUrl) throw new Error("No remote RedRouter URL configured");
    const options = {
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        "x-rr-internal-models-fetch": "1",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    };
    const proxy = await resolveConnectionProxyConfig(data);
    const url = redRouterEndpoint(data.baseUrl, "models");
    const response = proxy.connectionProxyEnabled || proxy.vercelRelayUrl
      ? await (await import("open-sse/utils/proxyFetch.js")).proxyAwareFetch(url, options, proxy)
      : await fetch(url, options);
    if (!response.ok) throw new Error(`Remote RedRouter models request failed (${response.status})`);
    const body = await response.json();
    const entries = Array.isArray(body) ? body : body?.data || body?.models;
    if (!Array.isArray(entries)) throw new Error("Remote RedRouter returned an invalid model catalog");
    const models = [...new Map(entries
      .filter((m) => typeof m?.id === "string" && m.id.trim())
      .map((m) => [m.id, m])).values()];
    const modelsSyncedAt = new Date().toISOString();
    if (persist && connection.id) {
      // A fetch must not overwrite an edit or resurrect a deleted connection.
      const current = await getProviderConnectionById(connection.id);
      if (current && current.apiKey === connection.apiKey && current.providerSpecificData?.baseUrl === data.baseUrl) {
        await updateProviderConnection(connection.id, {
          providerSpecificData: { ...current.providerSpecificData, discoveredModels: models, modelsSyncedAt },
        });
      }
    }
    return { models, modelsSyncedAt };
  } catch (error) {
    return { models: cached, warning: error.message, cached: true };
  }
}
