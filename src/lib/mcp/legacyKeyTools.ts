import { z } from "zod";

import { getApiKeyById, getApiKeys } from "@/lib/db/apiKeys";
import { getKeyQuotaLimits, type KeyQuotaLimits } from "@/lib/db/keyQuota";
import { getApiKeyTags } from "@/lib/db/apiKeys/tags";
import { LegacyMcpToolError, type LegacyMcpTool } from "./legacyProtocol";

type KeyRecord = NonNullable<Awaited<ReturnType<typeof getApiKeyById>>>;

export interface LegacyKeyStore {
  getById(id: string): Promise<KeyRecord | null>;
  list(): Promise<KeyRecord[]>;
  limits(id: string): KeyQuotaLimits;
  tags(id: string): string[];
}

const defaultStore: LegacyKeyStore = {
  getById: getApiKeyById,
  list: () => getApiKeys(),
  limits: getKeyQuotaLimits,
  tags: getApiKeyTags,
};

// Never spread a DB row into an MCP result: the row also contains the bearer secret.
export function publicLegacyKey(key: KeyRecord, quota: KeyQuotaLimits, tags: string[]) {
  return {
    id: key.id,
    name: key.name,
    role: key.scopes.includes("manage") ? "admin" : "standard",
    tags,
    is_active: key.isActive,
    created_at: key.createdAt,
    limits: {
      rpm: quota.rpmLimit,
      tokensPerDay: quota.dailyTokensLimit,
      usdPerMonth: quota.monthlyAmountUsd,
      tpm: quota.tpmLimit,
    },
    model_access_mode: key.modelAccessMode,
    allowed_models: key.allowedModels,
    blocked_models: key.blockedModels,
    allowed_combos: key.allowedCombos,
    bound_accounts: key.allowedConnections.length || null,
    scopes: key.scopes,
    catalog_scope: key.catalogScope,
    max_requests_per_day: key.maxRequestsPerDay ?? null,
    max_requests_per_minute: key.maxRequestsPerMinute ?? null,
    daily_usage_limit_usd: key.dailyUsageLimitUsd ?? null,
    weekly_usage_limit_usd: key.weeklyUsageLimitUsd ?? null,
    expires_at: key.expiresAt ?? null,
  };
}

const emptyArgs = z.object({}).strict();
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createLegacyKeyTools(store: LegacyKeyStore = defaultStore): LegacyMcpTool[] {
  return [
    {
      name: "get_api_key",
      title: "Get this API key",
      description: "Metadata and access policy for the calling API key. Never returns its secret.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      argsSchema: emptyArgs,
      annotations: readOnly,
      run: async (_args, context) => {
        const key = await store.getById(context.apiKeyId);
        if (!key) throw new LegacyMcpToolError("unknown_key", "API key not found");
        return {
          api_key: publicLegacyKey(
            key,
            store.limits(context.apiKeyId),
            store.tags(context.apiKeyId)
          ),
        };
      },
    },
    {
      name: "list_api_keys",
      title: "List API keys",
      description:
        "Metadata for API keys. Requires a management-scoped API key; never returns secrets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      argsSchema: emptyArgs,
      annotations: readOnly,
      admin: true,
      run: async (_args, context) => {
        if (!context.isAdmin)
          throw new LegacyMcpToolError("forbidden", "Management access required");
        const keys = await store.list();
        return {
          total: keys.length,
          api_keys: keys.map((key) =>
            publicLegacyKey(key, store.limits(String(key.id)), store.tags(String(key.id)))
          ),
        };
      },
    },
  ];
}
