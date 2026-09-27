import { z } from "zod";

import { getApiKeyById } from "@/lib/db/apiKeys";
import {
  aggregateLedgerThisMonth,
  getKeyLedgerUsage,
  type KeyLedgerUsage,
} from "@/lib/db/costLedger";
import { getKeyQuotaLimits, type KeyQuotaLimits } from "@/lib/db/keyQuota";
import { LegacyMcpToolError, type LegacyMcpTool } from "./legacyProtocol";

export interface LegacyUsageStore {
  keyExists(id: string): Promise<boolean>;
  usage(id: string, sinceIso: string, todayIso: string): KeyLedgerUsage;
  monthCost(id: string, nowIso: string): number;
  limits(id: string): KeyQuotaLimits;
}

const defaultStore: LegacyUsageStore = {
  keyExists: async (id) => (await getApiKeyById(id)) !== null,
  usage: getKeyLedgerUsage,
  monthCost: (id, nowIso) => aggregateLedgerThisMonth(id, nowIso).amountUsd,
  limits: getKeyQuotaLimits,
};

const argsSchema = z
  .object({
    hours: z.number().int().min(1).max(720).optional(),
    api_key_id: z.string().min(1).optional(),
  })
  .strict();

const roundUsd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function createLegacyUsageTool(store: LegacyUsageStore = defaultStore): LegacyMcpTool {
  return {
    name: "get_usage",
    title: "Get usage",
    description:
      "Request and cost usage from the per-key ledger. Another key requires management access.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", minimum: 1, maximum: 720 },
        api_key_id: { type: "string" },
      },
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
      const targetId = args.api_key_id ?? context.apiKeyId;
      if (targetId !== context.apiKeyId) {
        if (!context.isAdmin)
          throw new LegacyMcpToolError("forbidden", "Management access required");
        if (!(await store.keyExists(targetId))) {
          throw new LegacyMcpToolError("unknown_key", "API key not found");
        }
      }
      const hours = args.hours ?? 24;
      const now = new Date();
      const nowIso = now.toISOString();
      const sinceIso = new Date(now.getTime() - hours * 3_600_000).toISOString();
      const todayIso = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      ).toISOString();
      const usage = store.usage(targetId, sinceIso, todayIso);
      const monthCost = store.monthCost(targetId, nowIso);
      const quota = store.limits(targetId);
      const monthlyLimit = quota.monthlyAmountUsd;
      return {
        api_key_id: targetId,
        currency: "USD",
        hours,
        source: "request_cost_ledger",
        totals: { ...usage.totals, cost: roundUsd(usage.totals.cost) },
        by_model: usage.by_model.map((row) => ({ ...row, cost: roundUsd(row.cost) })),
        limits: {
          rpm: quota.rpmLimit,
          tokensPerDay: quota.dailyTokensLimit,
          usdPerMonth: monthlyLimit,
          tpm: quota.tpmLimit,
        },
        this_month: { cost: roundUsd(monthCost), tokens_today: usage.tokens_today },
        remaining: {
          usd_this_month:
            monthlyLimit !== null ? roundUsd(Math.max(0, monthlyLimit - monthCost)) : null,
          tokens_today:
            quota.dailyTokensLimit !== null
              ? Math.max(0, quota.dailyTokensLimit - usage.tokens_today)
              : null,
        },
      };
    },
  };
}
