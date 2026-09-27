import { z } from "zod";

import { LegacyMcpToolError, type LegacyMcpContext, type LegacyMcpTool } from "./legacyProtocol";

export interface LegacyProviderConnection {
  id: string;
  provider: string;
  isActive: boolean;
  rateLimitedUntil: string | null;
  testStatus: string | null;
}

export interface LegacyProviderStore {
  keyScope(token: string): Promise<{
    allowedConnections: string[];
    allowedQuotas: string[];
    quotaConnections: string[];
  } | null>;
  connections(): Promise<LegacyProviderConnection[]>;
  modelOwners(context: LegacyMcpContext): Promise<Array<{ id: string; ownedBy: string }>>;
}

type AccountState = "ok" | "quota_exhausted" | "rate_limited" | "error" | "disabled" | "unknown";

function accountState(connection: LegacyProviderConnection, now: number): AccountState {
  if (!connection.isActive) return "disabled";
  if (connection.testStatus === "credits_exhausted") return "quota_exhausted";
  if (connection.rateLimitedUntil && Date.parse(connection.rateLimitedUntil) > now) {
    return "rate_limited";
  }
  if (connection.testStatus === "active" || connection.testStatus === "success") return "ok";
  if (connection.testStatus && connection.testStatus !== "unknown") return "error";
  return "unknown";
}

const emptyArgs = z.object({}).strict();

export function createLegacyProviderTool(store: LegacyProviderStore): LegacyMcpTool {
  return {
    name: "list_providers",
    title: "List providers",
    description:
      "Connected providers visible to the calling key, with account status and model counts; no account identity or credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    argsSchema: emptyArgs,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (_args, context) => {
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
      const owners = await store.modelOwners(context);
      const modelIds = new Map<string, Set<string>>();
      for (const model of owners) {
        if (!model.ownedBy || model.ownedBy === "combo") continue;
        const ids = modelIds.get(model.ownedBy) ?? new Set<string>();
        ids.add(model.id);
        modelIds.set(model.ownedBy, ids);
      }
      const now = Date.now();
      const providers = new Map<string, LegacyProviderConnection[]>();
      for (const connection of await store.connections()) {
        if (allowed && !allowed.has(connection.id)) continue;
        if (!modelIds.has(connection.provider)) continue;
        const accounts = providers.get(connection.provider) ?? [];
        accounts.push(connection);
        providers.set(connection.provider, accounts);
      }
      return {
        total: providers.size,
        providers: [...providers]
          .map(([id, connections]) => {
            const accounts = {
              total: connections.length,
              ok: 0,
              quota_exhausted: 0,
              rate_limited: 0,
              error: 0,
              disabled: 0,
              unknown: 0,
            };
            let until: string | null = null;
            for (const connection of connections) {
              const state = accountState(connection, now);
              accounts[state] += 1;
              if (
                state === "rate_limited" &&
                connection.rateLimitedUntil &&
                (!until || connection.rateLimitedUntil < until)
              ) {
                until = connection.rateLimitedUntil;
              }
            }
            const state = accounts.ok
              ? "ok"
              : accounts.quota_exhausted
                ? "quota_exhausted"
                : accounts.rate_limited
                  ? "rate_limited"
                  : accounts.error
                    ? "error"
                    : accounts.unknown
                      ? "unknown"
                      : "disabled";
            return {
              id,
              name: id,
              accounts,
              status: { state, ...(state === "rate_limited" && until ? { until } : {}) },
              usable: accounts.ok > 0 ? true : accounts.unknown > 0 ? null : false,
              health: null,
              models: modelIds.get(id)?.size ?? 0,
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
    },
  };
}
