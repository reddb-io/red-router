import { getProviderConnectionById, updateProviderConnection } from "@/models";
import {
  RED_ROUTER_CHAIN_HEADER,
  RED_ROUTER_INSTANCE_HEADER,
  appendRedRouterHop,
  parseRedRouterChain,
  redRouterEndpoint,
  routableRemoteEntries,
} from "open-sse/config/redRouter.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const REFRESH_MS = 5 * 60 * 1000;

// Each remote catalog a connection caches: where the remote serves it, and the
// providerSpecificData fields holding the list, its sync time and the remote's instance.
const CATALOGS = {
  llm: { path: "models", models: "discoveredModels", syncedAt: "modelsSyncedAt", instance: "modelsInstanceId" },
  systemone: {
    path: "models/systemone",
    models: "discoveredSystemOneModels",
    syncedAt: "systemOneModelsSyncedAt",
    instance: "systemOneModelsInstanceId",
  },
};

/**
 * A remote RedRouter's catalog (chat models, or System One models with
 * `kind: "systemone"`), cached per connection: different remote keys can expose
 * different catalogs.
 *
 * `chain` is the hop chain sent with the fetch, this router last (default: this
 * router alone). The remote lists its own upstream routers' models under it, and
 * the result drops entries that would come back to a router in it or exceed the
 * hop limit. Only a fetch this router starts (a one-router chain) is saved: a
 * longer chain's answer is cut to what is left of it.
 */
export async function syncRemoteRouterCatalog(connection, { force = false, persist = true, kind = "llm", chain = null } = {}) {
  const catalog = CATALOGS[kind] || CATALOGS.llm;
  const hops = chain ? parseRedRouterChain(chain) : parseRedRouterChain(appendRedRouterHop(""));
  const data = connection.providerSpecificData || {};
  const cached = Array.isArray(data[catalog.models]) ? data[catalog.models] : [];
  const cachedInstance = typeof data[catalog.instance] === "string" ? data[catalog.instance] : null;
  const routable = (models, remoteInstance) => routableRemoteEntries(models, { remoteInstance, chain: hops });
  if (!force && data[catalog.syncedAt] && Date.now() - Date.parse(data[catalog.syncedAt]) < REFRESH_MS) {
    return { models: routable(cached, cachedInstance), instanceId: cachedInstance };
  }
  try {
    if (!data.baseUrl) throw new Error("No remote RedRouter URL configured");
    const options = {
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        // Older remotes ignore the chain and skip their own upstream routers on this.
        "x-rr-internal-models-fetch": "1",
        [RED_ROUTER_CHAIN_HEADER]: hops.join(","),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    };
    const proxy = await resolveConnectionProxyConfig(data);
    const url = redRouterEndpoint(data.baseUrl, catalog.path);
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
    const instanceId = response.headers?.get?.(RED_ROUTER_INSTANCE_HEADER)?.trim() || null;
    const syncedAt = new Date().toISOString();
    if (persist && hops.length === 1 && connection.id) {
      // A fetch must not overwrite an edit or resurrect a deleted connection.
      const current = await getProviderConnectionById(connection.id);
      if (current && current.apiKey === connection.apiKey && current.providerSpecificData?.baseUrl === data.baseUrl) {
        await updateProviderConnection(connection.id, {
          providerSpecificData: {
            ...current.providerSpecificData,
            [catalog.models]: models,
            [catalog.syncedAt]: syncedAt,
            [catalog.instance]: instanceId,
          },
        });
      }
    }
    return { models: routable(models, instanceId), instanceId, [catalog.syncedAt]: syncedAt };
  } catch (error) {
    return { models: routable(cached, cachedInstance), instanceId: cachedInstance, warning: error.message, cached: true };
  }
}
