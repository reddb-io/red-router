// Background reader for quota-aware routing: every few minutes, reads the quota
// of each active account whose provider has a usage API and keeps it in the
// in-memory snapshot the account selector consults. Runs only while
// settings.quotaAwareRouting is on, and outside the account-selection mutex.
import "open-sse/index.js";

import { getProviderConnections, getSettings } from "@/lib/localDb";
import { getUsageForProvider, hasUsageHandler } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { QUOTA_REFRESH_MS, recordQuotaSnapshot, quotaSnapshotState as g } from "@/sse/services/quotaSnapshot.js";

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

function createDefaultDeps() {
  return { getProviderConnections, resolveConnectionProxyConfig, refreshAndUpdateCredentials, getUsageForProvider, hasUsageHandler };
}

/** Read one account's quota now and keep it as its snapshot (also used by the MCP get_quotas tool). */
export async function readConnectionQuota(conn, deps = createDefaultDeps()) {
  const proxyOptions = buildProxyOptions(await deps.resolveConnectionProxyConfig(conn.providerSpecificData));
  let connection = conn;
  if (connection.authType === "oauth") {
    const { connection: refreshed } = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = { ...connection, ...refreshed };
  }
  recordQuotaSnapshot(connection.id, await deps.getUsageForProvider(connection, proxyOptions));
}

export async function runQuotaSnapshotTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const connections = await deps.getProviderConnections({ isActive: true });
    for (const conn of connections.filter((c) => deps.hasUsageHandler(c.provider))) {
      try {
        await readConnectionQuota(conn, deps);
      } catch (e) {
        console.warn(`[QuotaSnapshot] ${conn.provider}:${conn.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn("[QuotaSnapshot] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

/** Start or stop the reader to match the setting. */
export function configureQuotaSnapshots(settings) {
  if (settings?.quotaAwareRouting === true) {
    if (g.interval) return;
    console.log("[QuotaSnapshot] quota-aware routing on: reading quotas every 5 min");
    runQuotaSnapshotTick().catch(() => {});
    g.interval = setInterval(() => { runQuotaSnapshotTick().catch(() => {}); }, QUOTA_REFRESH_MS);
    if (g.interval.unref) g.interval.unref();
  } else if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
    console.log("[QuotaSnapshot] quota-aware routing off");
  }
}

export async function startQuotaSnapshots() {
  configureQuotaSnapshots(await getSettings());
}
