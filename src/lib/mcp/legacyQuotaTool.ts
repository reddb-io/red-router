import { z } from "zod";

import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getRawProviderConnections } from "@/lib/db/providers";
import { getLatestQuotaSnapshotsForConnection } from "@/lib/db/quotaSnapshots";
import { resolveQuotaKeyScope } from "@/lib/quota/quotaKey";
import { LegacyMcpToolError, type LegacyMcpTool } from "./legacyProtocol";

interface QuotaConnection {
  id: string;
  provider: string;
  isActive: boolean;
}

interface QuotaWindow {
  name: string;
  remainingPct: number | null;
  resetAt: string | null;
  observedAt: string | null;
}

export interface LegacyQuotaStore {
  keyScope(token: string): Promise<{
    allowedConnections: string[];
    allowedQuotas: string[];
    quotaConnections: string[];
  } | null>;
  connections(): Promise<QuotaConnection[]>;
  windows(connectionId: string): QuotaWindow[];
}

const defaultStore: LegacyQuotaStore = {
  keyScope: async (token) => {
    const metadata = await getApiKeyMetadata(token);
    if (!metadata) return null;
    const quota = metadata.allowedQuotas.length
      ? await resolveQuotaKeyScope(metadata.allowedQuotas)
      : null;
    return {
      allowedConnections: metadata.allowedConnections,
      allowedQuotas: metadata.allowedQuotas,
      quotaConnections: quota?.connectionIds ?? [],
    };
  },
  connections: async () => {
    const rows = await getRawProviderConnections({}, undefined, undefined, [
      "id",
      "provider",
      "is_active",
    ]);
    return rows
      .filter((row) => typeof row.id === "string" && typeof row.provider === "string")
      .map((row) => ({
        id: String(row.id),
        provider: String(row.provider),
        isActive: row.isActive !== false && row.isActive !== 0,
      }));
  },
  windows: (connectionId) =>
    getLatestQuotaSnapshotsForConnection(connectionId).map((row) => {
      const normalized = row as unknown as Record<string, unknown>;
      const remaining = normalized.remainingPercentage ?? normalized.remaining_percentage;
      return {
        name: String(normalized.windowKey ?? normalized.window_key ?? "unknown"),
        remainingPct: typeof remaining === "number" ? remaining : null,
        resetAt: String(normalized.nextResetAt ?? normalized.next_reset_at ?? "") || null,
        observedAt: String(normalized.createdAt ?? normalized.created_at ?? "") || null,
      };
    }),
};

const argsSchema = z
  .object({ provider: z.string().min(1).optional(), refresh: z.boolean().optional() })
  .strict();

export function createLegacyQuotaTool(store: LegacyQuotaStore = defaultStore): LegacyMcpTool {
  return {
    name: "get_quotas",
    title: "Get quotas",
    description:
      "Last persisted quota windows for connections the calling API key may use. Live refresh is unavailable.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string" }, refresh: { type: "boolean" } },
      additionalProperties: false,
    },
    argsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (rawArgs, context) => {
      const args = argsSchema.parse(rawArgs);
      if (args.refresh === true) {
        throw new LegacyMcpToolError("unsupported_refresh", "Live quota refresh is unavailable");
      }
      if (!context.apiKeyToken) throw new LegacyMcpToolError("forbidden", "API key required");
      const scope = await store.keyScope(context.apiKeyToken);
      if (!scope) throw new LegacyMcpToolError("forbidden", "API key not found");
      const allowed = scope.allowedQuotas.length
        ? new Set(
            scope.quotaConnections.filter(
              (id) => scope.allowedConnections.length === 0 || scope.allowedConnections.includes(id)
            )
          )
        : scope.allowedConnections.length
          ? new Set(scope.allowedConnections)
          : null;
      const connections = (await store.connections()).filter(
        (connection) =>
          connection.isActive &&
          (!allowed || allowed.has(connection.id)) &&
          (!args.provider || connection.provider === args.provider)
      );
      if (connections.length > 500) {
        throw new LegacyMcpToolError("too_many_accounts", "Too many matching accounts");
      }
      const providers = new Map<string, Array<Record<string, unknown>>>();
      for (const connection of connections) {
        const snapshots = store.windows(connection.id);
        const account = {
          connection_id: connection.id,
          account: (providers.get(connection.provider)?.length ?? 0) + 1,
          as_of: snapshots.reduce<string | null>(
            (latest, window) =>
              window.observedAt && (!latest || window.observedAt > latest)
                ? window.observedAt
                : latest,
            null
          ),
          quotas: snapshots.map((window) => ({
            name: window.name,
            used: null,
            total: null,
            remaining: null,
            remaining_pct: window.remainingPct,
            unlimited: null,
            reset_at: window.resetAt,
          })),
          ...(snapshots.length === 0 ? { error: "no quota report yet" } : {}),
        };
        const accounts = providers.get(connection.provider) ?? [];
        accounts.push(account);
        providers.set(connection.provider, accounts);
      }
      return {
        total_accounts: connections.length,
        providers: [...providers].map(([provider, accounts]) => ({ provider, accounts })),
      };
    },
  };
}
