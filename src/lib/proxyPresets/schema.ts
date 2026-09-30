import { z } from "zod";
import type { PresetParamDescriptor, PresetValues, ProxyPreset } from "./catalog";

/** Longest accepted value for any preset parameter. */
export const PRESET_PARAM_MAX_LENGTH = 200;

/** True when the string contains a C0 control character or DEL (newlines, NUL, tabs...). */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stringField(param: PresetParamDescriptor): z.ZodType<string> {
  let field = z
    .string()
    .trim()
    .max(PRESET_PARAM_MAX_LENGTH, `${param.label} is too long`)
    .refine((value) => !hasControlCharacters(value), `${param.label} has invalid characters`);
  if (param.required) field = field.min(1, `${param.label} is required`);
  const pattern = param.pattern;
  if (pattern && param.type === "text") {
    const regex = new RegExp(pattern);
    // Empty stays legal for optional params: it means "not set".
    field = field.refine(
      (value) => value === "" || regex.test(value),
      param.patternHint ?? `${param.label} has an invalid format`
    );
  }
  return field;
}

function fieldFor(param: PresetParamDescriptor): z.ZodTypeAny {
  if (param.type === "toggle") return z.boolean().optional();
  if (param.type === "select") {
    const values = (param.options ?? []).map((option) => option.value);
    const enumField = z.enum(values as [string, ...string[]], {
      message: `${param.label} is not one of the allowed values`,
    });
    return param.required ? enumField : enumField.optional();
  }
  // text and password
  const field = stringField(param);
  return param.required ? field : field.optional();
}

/**
 * Zod schema for the `params` object of a preset, generated from its descriptors. Strict: a key the
 * preset does not declare is rejected rather than ignored.
 */
export function buildPresetParamsSchema(preset: ProxyPreset) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of preset.params) shape[param.name] = fieldFor(param);
  return z.strictObject(shape);
}

/** Request body of POST /api/settings/proxy-presets. `params` is validated per preset afterwards. */
export const applyProxyPresetBodySchema = z.strictObject({
  presetId: z.string().trim().min(1, "presetId is required").max(64),
  name: z
    .string()
    .trim()
    .min(1, "name is required")
    .max(120)
    .refine((value) => !hasControlCharacters(value), "name has invalid characters"),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** Fills descriptor defaults for params the caller left out. */
export function withParamDefaults(preset: ProxyPreset, values: PresetValues): PresetValues {
  const out: PresetValues = { ...values };
  for (const param of preset.params) {
    if (out[param.name] === undefined && param.defaultValue !== undefined) {
      out[param.name] = param.defaultValue;
    }
  }
  return out;
}
