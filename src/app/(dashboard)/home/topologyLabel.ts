import { getProviderDisplayLabel } from "../../../shared/utils/providerDisplayLabel";

type TopologyConnection = {
  provider?: string;
  name?: string | null;
  isActive?: boolean | null;
  providerSpecificData?: { nodeName?: string | null } | null;
};

/** Display names never replace the provider identity used by routing or node clicks. */
export function resolveTopologyProviderLabel(
  providerId: string,
  providerNodes: Array<{ id?: string; prefix?: string; name?: string }>,
  connections: TopologyConnection[],
  fallbackName: string
): string {
  const normalizedId = providerId.trim().toLowerCase();
  const compatible =
    normalizedId.startsWith("openai-compatible-") ||
    normalizedId.startsWith("anthropic-compatible-");
  if (!compatible) return fallbackName;

  const activeConnections = connections.filter(
    (connection) =>
      connection.provider?.trim().toLowerCase() === normalizedId && connection.isActive !== false
  );
  const names = Array.from(
    new Set(activeConnections.map((connection) => connection.name?.trim()).filter(Boolean))
  );
  if (names.length) return names.join(", ");

  const node = providerNodes.find(
    (candidate) =>
      candidate.id?.trim().toLowerCase() === normalizedId ||
      candidate.prefix?.trim().toLowerCase() === normalizedId
  );
  const nodeName =
    node?.name?.trim() ||
    activeConnections
      .find((connection) => connection.providerSpecificData?.nodeName?.trim())
      ?.providerSpecificData?.nodeName?.trim();
  return nodeName || getProviderDisplayLabel(normalizedId) || fallbackName;
}

/**
 * Resolve the display label for a provider node in the home topology graph (#3198).
 *
 * The parent (HomePageClient) pre-resolves a friendly name into `entry.name` via
 * `getProviderDisplayLabel` (which knows custom provider nodes). `getProviderConfig`
 * only knows built-in providers and falls back to `{ name: providerId }` for unknown
 * ids — so for a custom provider (`openai-compatible-chat-<uuid>`) its `name` is the
 * raw UUID. The pre-resolved `entry.name` must therefore win over the config fallback;
 * otherwise the topology renders the UUID instead of the user's provider name.
 */
export function resolveTopologyNodeLabel(
  entryName: string | undefined | null,
  configName: string | undefined | null,
  providerId: string
): string {
  return (entryName && entryName.trim()) || (configName && configName.trim()) || providerId;
}
