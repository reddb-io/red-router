import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createApiKey } from "@/lib/db/apiKeys";
import { snapshotApiKeyTags } from "@/lib/db/apiKeys/tags";
import { LegacyMcpToolError, type LegacyMcpContext, type LegacyMcpTool } from "./legacyProtocol";

const limitsSchema = z
  .object({
    rpm: z.number().int().min(1).optional(),
    tokensPerDay: z.number().int().min(1).optional(),
    usdPerMonth: z.number().min(0.01).optional(),
  })
  .strict();

const argsSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim().slice(0, 100))
      .pipe(z.string().min(1)),
    tags: z.array(z.string()).optional(),
    limits: limitsSchema.optional(),
    id_format: z.enum(["prefixed", "flat"]).optional(),
  })
  .strict();

type CreateArgs = z.infer<typeof argsSchema>;
type CreatedKey = Awaited<ReturnType<typeof createApiKey>>;

export interface LegacyCreateKeyStore {
  create(args: CreateArgs, context: LegacyMcpContext): Promise<CreatedKey>;
}

/** Never probe the host for a machine ID from a remotely reachable MCP request. */
export function machineIdForLegacyKey(callerMachineId?: string | null): string {
  if (callerMachineId && /^[0-9a-f]{16}$/i.test(callerMachineId)) {
    return callerMachineId.toLowerCase();
  }
  return randomBytes(8).toString("hex");
}

const defaultStore: LegacyCreateKeyStore = {
  create: async (args, context) =>
    createApiKey(args.name, machineIdForLegacyKey(context.apiKeyMachineId), [], {
      tags: args.tags,
      quotaLimits: args.limits
        ? {
            rpmLimit: args.limits.rpm,
            dailyTokensLimit: args.limits.tokensPerDay,
            monthlyAmountUsd: args.limits.usdPerMonth,
          }
        : undefined,
      modelIdFormat: args.id_format ?? "prefixed",
    }),
};

export function createLegacyCreateKeyTool(
  store: LegacyCreateKeyStore = defaultStore
): LegacyMcpTool {
  return {
    name: "create_api_key",
    title: "Create API key",
    description:
      "Create a standard key and return its bearer secret once. Requires management access. Confirm with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 100 },
        tags: { type: "array", items: { type: "string" } },
        limits: {
          type: "object",
          properties: {
            rpm: { type: "integer", minimum: 1 },
            tokensPerDay: { type: "integer", minimum: 1 },
            usdPerMonth: { type: "number", minimum: 0.01 },
          },
          additionalProperties: false,
        },
        id_format: { type: "string", enum: ["prefixed", "flat"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
    argsSchema,
    admin: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    run: async (rawArgs, context) => {
      if (!context.isAdmin) throw new LegacyMcpToolError("forbidden", "Management access required");
      const args = argsSchema.parse(rawArgs);
      const tags = snapshotApiKeyTags(args.tags) ?? [];
      const created = await store.create({ ...args, tags }, context);
      return {
        api_key: {
          id: created.id,
          name: created.name,
          tags,
          is_active: true,
          key_hint: `…${created.key.slice(-4)}`,
          id_format: args.id_format ?? "prefixed",
          limits: args.limits ?? null,
          model_access: null,
          bound_accounts: null,
          role: "standard",
          created_at: created.createdAt,
        },
        key: created.key,
        note: "Give this key to the client that needs it. It is also shown in Endpoint & Keys.",
      };
    },
  };
}
