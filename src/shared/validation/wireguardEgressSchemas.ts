/**
 * Request schemas for the WireGuard egress routes. Client-reachable on purpose, so this file
 * depends on zod only (see tests/unit/authz/spawn-capable-prefixes-client-safe.test.ts).
 *
 * The config text is validated for real by `src/lib/wireguard/egressConfig.ts` on the server; the
 * schema only bounds its size so an absurd body is refused before parsing.
 */
import { z } from "zod";

export const WIREGUARD_EGRESS_MAX_CONFIG_CHARS = 16 * 1024;

const profileName = z
  .string()
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .refine((value) => value.length >= 1 && value.length <= 64, "Name must be 1-64 characters")
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Name contains control characters");

export const wireGuardEgressCreateSchema = z
  .object({
    name: profileName,
    config: z
      .string()
      .min(1, "Paste the WireGuard configuration")
      .max(WIREGUARD_EGRESS_MAX_CONFIG_CHARS, "The configuration is larger than 16 KB"),
  })
  .strict();

export const wireGuardEgressActionSchema = z
  .object({ action: z.enum(["enable", "disable", "restart"]) })
  .strict();

export type WireGuardEgressCreateBody = z.infer<typeof wireGuardEgressCreateSchema>;
export type WireGuardEgressAction = z.infer<typeof wireGuardEgressActionSchema>["action"];
