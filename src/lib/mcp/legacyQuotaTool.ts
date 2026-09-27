import { z } from "zod";

import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getProviderLimitsCache } from "@/lib/db/providerLimits";
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
  used: number | null;
  total: number | null;
  remaining: number | null;
  remainingPct: number | null;
  unlimited: boolean | null;
  resetAt: string | null;
  observedAt: string | null;
}

const REFRESH_TIMEOUT_MS = 20_000;
const REFRESH_BUDGET_MS = 30_000;
const REFRESH_CONCURRENCY = 4;

export function parseLegacyQuotaWindows(quotas: unknown, observedAt: string | null): QuotaWindow[] {
  if (!quotas || typeof quotas !== "object" || Array.isArray(quotas)) return [];
  return Object.entries(quotas).map(([name, value]) => {
    const data =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const used = typeof data.used === "number" && Number.isFinite(data.used) ? data.used : null;
    const total = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : null;
    const remaining =
      typeof data.remaining === "number" && Number.isFinite(data.remaining)
        ? data.remaining
        : total !== null && used !== null
          ? total - used
          : null;
    const reportedPercentage =
      typeof data.remainingPercentage === "number" && Number.isFinite(data.remainingPercentage)
        ? data.remainingPercentage
        : null;
    return {
      name,
      used,
      total,
      remaining,
      remainingPct:
        reportedPercentage ??
        (total !== null && total > 0 && remaining !== null
          ? Math.round((remaining / total) * 1_000) / 10
          : null),
      unlimited: typeof data.unlimited === "boolean" ? data.unlimited : null,
      resetAt:
        typeof data.resetAt === "string"
          ? data.resetAt
          : typeof data.reset_at === "string"
            ? data.reset_at
            : null,
      observedAt,
    };
  });
}

async function withRefreshTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("quota refresh timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LegacyQuotaStore {
  keyScope(token: string): Promise<{
    allowedConnections: string[];
    allowedQuotas: string[];
    quotaConnections: string[];
  } | null>;
  connections(): Promise<QuotaConnection[]>;
  windows(connectionId: string): QuotaWindow[];
  refresh(connectionId: string): Promise<QuotaWindow[]>;
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
  windows: (connectionId) => {
    const cache = getProviderLimitsCache(connectionId);
    if (cache?.quotas && Object.keys(cache.quotas).length > 0) {
      return parseLegacyQuotaWindows(cache.quotas, cache.fetchedAt);
    }
    return getLatestQuotaSnapshotsForConnection(connectionId).map((row) => {
      const normalized = row as unknown as Record<string, unknown>;
      const remaining = normalized.remainingPercentage ?? normalized.remaining_percentage;
      return {
        name: String(normalized.windowKey ?? normalized.window_key ?? "unknown"),
        used: null,
        total: null,
        remaining: null,
        remainingPct: typeof remaining === "number" ? remaining : null,
        unlimited: null,
        resetAt: String(normalized.nextResetAt ?? normalized.next_reset_at ?? "") || null,
        observedAt: String(normalized.createdAt ?? normalized.created_at ?? "") || null,
      };
    });
  },
  refresh: async (connectionId) => {
    const { fetchAndPersistProviderLimits } = await import("@/lib/usage/providerLimits");
    const { usage, cache } = await fetchAndPersistProviderLimits(connectionId, "manual", {
      allowRotatingRefresh: true,
    });
    if (usage._stale === true || cache.message) {
      throw new Error("quota refresh returned stale data");
    }
    return parseLegacyQuotaWindows(cache.quotas, cache.fetchedAt);
  },
};

const argsSchema = z
  .object({ provider: z.string().min(1).optional(), refresh: z.boolean().optional() })
  .strict();

export function createLegacyQuotaTool(store: LegacyQuotaStore = defaultStore): LegacyMcpTool {
  return {
    name: "get_quotas",
    title: "Get quotas",
    description:
      "Quota windows for connections the calling API key may use. Refresh reads the provider now.",
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
      openWorldHint: true,
    },
    run: async (rawArgs, context) => {
      const args = argsSchema.parse(rawArgs);
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
      const refreshed = new Map<string, { windows: QuotaWindow[]; error?: string }>();
      if (args.refresh === true) {
        const deadline = Date.now() + REFRESH_BUDGET_MS;
        let timedOut = false;
        for (let offset = 0; offset < connections.length; offset += REFRESH_CONCURRENCY) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          const batch = connections.slice(offset, offset + REFRESH_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (connection) => {
              try {
                return {
                  id: connection.id,
                  windows: await withRefreshTimeout(
                    store.refresh(connection.id),
                    Math.min(REFRESH_TIMEOUT_MS, remainingMs)
                  ),
                };
              } catch (error) {
                const isTimeout =
                  error instanceof Error && error.message === "quota refresh timed out";
                if (isTimeout) timedOut = true;
                return {
                  id: connection.id,
                  windows: store.windows(connection.id),
                  error: isTimeout ? "quota refresh timed out" : "quota refresh failed",
                };
              }
            })
          );
          for (const result of results) refreshed.set(result.id, result);
          // The underlying fetcher has no AbortSignal contract. A timed-out fetch may still be
          // running, so do not start another batch and exceed the four in-flight upstream calls.
          if (timedOut) break;
        }
      }
      const providers = new Map<string, Array<Record<string, unknown>>>();
      for (const connection of connections) {
        const refresh = refreshed.get(connection.id);
        const snapshots = refresh?.windows ?? store.windows(connection.id);
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
            used: window.used,
            total: window.total,
            remaining: window.remaining,
            remaining_pct: window.remainingPct,
            unlimited: window.unlimited,
            reset_at: window.resetAt,
          })),
          ...(refresh?.error
            ? { error: refresh.error }
            : args.refresh === true && !refresh
              ? { error: "quota refresh budget exceeded" }
              : snapshots.length === 0
                ? { error: "no quota report yet" }
                : {}),
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
