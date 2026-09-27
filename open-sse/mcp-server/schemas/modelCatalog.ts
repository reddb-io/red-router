import { z } from "zod";

/** MCP model availability is an account-aware projection, not just catalog presence. */
export const listModelsCatalogOutput = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      capabilities: z.array(z.string()),
      status: z.enum(["available", "degraded", "unavailable"]),
      unavailableReason: z
        .enum(["quota_exhausted", "model_locked", "rate_limited", "terminal"])
        .optional(),
      accounts: z.object({ available: z.number(), total: z.number() }).optional(),
      thinkingEffort: z.string().optional(),
      pricing: z
        .object({
          inputPerMillion: z.number().nullable(),
          outputPerMillion: z.number().nullable(),
        })
        .optional(),
    })
  ),
});
