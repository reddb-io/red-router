/** Zod schemas for the usage sink management API. */
import { z } from "zod";
import { USAGE_SINK_TYPES } from "./transports";

export const WINDOW_SIZES_SEC = [300, 900, 1800, 3600] as const;

const windowSec = z.union([z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]);
const configObject = z.record(z.string(), z.unknown());
const apiKeyIds = z.array(z.string().min(1).max(200)).max(200);

export const createSinkSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(USAGE_SINK_TYPES).optional().default("webhook"),
    mode: z.enum(["instant", "window"]),
    windowSec: windowSec.optional(),
    config: configObject.optional(),
    // The original webhook-only body shape: folded into `config` for a webhook sink.
    url: z.string().max(2048).optional(),
    secret: z.string().max(1024).optional(),
    apiKeyIds: apiKeyIds.optional(),
    enabled: z.boolean().optional().default(false),
  })
  .strict();

export const updateSinkSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    config: configObject.optional(),
    url: z.string().max(2048).optional(),
    secret: z.string().max(1024).optional(),
    mode: z.enum(["instant", "window"]).optional(),
    windowSec: windowSec.optional(),
    enabled: z.boolean().optional(),
    apiKeyIds: apiKeyIds.optional(),
  })
  .strict();

export const testSinkSchema = z
  .object({
    config: configObject.optional(),
    mode: z.enum(["instant", "window"]).optional(),
    windowSec: windowSec.optional(),
  })
  .strict();

export const deliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
  status: z.enum(["pending", "sending", "delivered", "dead", "failed"]).optional(),
});

export const keySearchQuerySchema = z.object({
  q: z.string().max(200).optional().default(""),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
});

/** The config a create/update body carries, with the legacy flat webhook fields folded in. */
export function bodyConfig(
  type: string,
  body: { config?: Record<string, unknown>; url?: string; secret?: string }
): Record<string, unknown> | undefined {
  if (type !== "webhook" || (body.url === undefined && body.secret === undefined)) {
    return body.config;
  }
  return {
    ...(body.config ?? {}),
    ...(body.url === undefined ? {} : { url: body.url }),
    ...(body.secret === undefined ? {} : { secret: body.secret }),
  };
}
