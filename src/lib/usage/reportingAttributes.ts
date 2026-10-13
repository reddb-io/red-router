import { z } from "zod";

/** Operator metadata only; never request headers, prompts or bearer credentials. */
export const usageAttributesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    z.union([z.string().max(256), z.number().finite(), z.boolean()])
  )
  .refine((value) => Object.keys(value).length <= 32, "At most 32 usage attributes")
  .refine(
    (value) =>
      !Object.keys(value).some((key) =>
        /(?:^|_)(?:secret|password|token|authorization|credential|api_key)(?:_|$)/.test(key)
      ),
    "Credentials cannot be reporting attributes"
  );

export type UsageAttributes = z.infer<typeof usageAttributesSchema>;

export function instanceUsageAttributes(): UsageAttributes {
  const configured = process.env.REDROUTER_USAGE_ATTRIBUTES_JSON;
  if (!configured) return {};
  try {
    return usageAttributesSchema.parse(JSON.parse(configured));
  } catch {
    throw new Error("Invalid REDROUTER_USAGE_ATTRIBUTES_JSON");
  }
}

export function snapshotUsageAttributes(input: unknown = {}): UsageAttributes {
  const attributes = usageAttributesSchema.parse(input);
  const instance = instanceUsageAttributes();
  for (const [key, value] of Object.entries(attributes)) {
    if (Object.hasOwn(instance, key) && instance[key] !== value) {
      throw new Error("Key usage attributes conflict with instance attributes");
    }
  }
  usageAttributesSchema.parse({ ...attributes, ...instance });
  return { ...attributes };
}

export function reportAllRequests(): boolean {
  return process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS === "true";
}
