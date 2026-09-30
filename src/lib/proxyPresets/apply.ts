import { upsertProxy } from "@/lib/db/proxies";
import { createProxyRegistrySchema } from "@/shared/validation/schemas";
import { getProxyPreset, type PresetValues, type ProxyPreset } from "./catalog";
import { applyProxyPresetBodySchema, buildPresetParamsSchema, withParamDefaults } from "./schema";

export type ProxyPresetErrorCode =
  "invalid_body" | "unknown_preset" | "invalid_params" | "invalid_proxy";

/** Domain error carrying a FIXED, public-safe message (never the submitted values). */
export class ProxyPresetError extends Error {
  code: ProxyPresetErrorCode;
  constructor(code: ProxyPresetErrorCode, message: string) {
    super(message);
    this.name = "ProxyPresetError";
    this.code = code;
  }
}

type IssueLike = { code?: string; message: string; path: PropertyKey[] };

/** First issue as a sentence built from our own descriptor messages, never from user input. */
function describeFirstIssue(issues: IssueLike[], fallback: string): string {
  const [first] = issues;
  if (!first) return fallback;
  if (first.code === "unrecognized_keys") return "Unknown parameter for this preset.";
  return first.message;
}

export interface AppliedProxyPreset {
  proxy: NonNullable<Awaited<ReturnType<typeof upsertProxy>>["proxy"]>;
  action: "created" | "updated";
  sticky: boolean;
  preset: Pick<ProxyPreset, "id" | "label">;
}

/**
 * Validates a `{presetId, name, params}` request, composes the registry proxy and stores it through
 * the same path bulk import uses (`upsertProxy`): identical host + port + username is updated in
 * place instead of duplicated. The returned proxy is the registry's redacted view.
 */
export async function applyProxyPreset(
  rawBody: unknown,
  options: { sessionId?: string } = {}
): Promise<AppliedProxyPreset> {
  const body = applyProxyPresetBodySchema.safeParse(rawBody);
  if (!body.success) {
    throw new ProxyPresetError(
      "invalid_body",
      describeFirstIssue(body.error.issues, "Invalid request.")
    );
  }
  const preset = getProxyPreset(body.data.presetId);
  if (!preset) throw new ProxyPresetError("unknown_preset", "Unknown proxy preset.");

  const submitted = body.data.params ?? {};
  const params = buildPresetParamsSchema(preset).safeParse(
    withParamDefaults(preset, submitted as PresetValues)
  );
  if (!params.success) {
    throw new ProxyPresetError(
      "invalid_params",
      describeFirstIssue(params.error.issues, "Invalid preset parameters.")
    );
  }

  const built = preset.build(params.data as PresetValues, { sessionId: options.sessionId });

  // The composed proxy goes through the registry's own create schema (types, host, port, lengths).
  const fields = createProxyRegistrySchema.safeParse({
    name: body.data.name,
    ...built.proxy,
  });
  if (!fields.success) {
    throw new ProxyPresetError("invalid_proxy", "The generated proxy is not valid.");
  }

  const result = await upsertProxy(fields.data);
  if (!result.proxy) throw new ProxyPresetError("invalid_proxy", "The proxy could not be saved.");
  return {
    proxy: result.proxy,
    action: result.action,
    sticky: built.sticky,
    preset: { id: preset.id, label: preset.label },
  };
}
