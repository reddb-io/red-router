import { commitRemoteRouterCatalog, readRemoteRouterCatalog } from "@/lib/db/remoteRouterCatalog";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";

import { createRemoteRouterCatalogSync } from "./remoteRouterCatalog";

export const syncRemoteRouterCatalog = createRemoteRouterCatalogSync({
  read: readRemoteRouterCatalog,
  commit: commitRemoteRouterCatalog,
  async fetch(url, init, connectionId) {
    const resolution = await resolveProxyForConnection(connectionId);
    return safeOutboundFetch(url, {
      ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
      ...init,
      guard: getProviderOutboundGuard(),
      proxyConfig: resolution.proxy,
    });
  },
});
