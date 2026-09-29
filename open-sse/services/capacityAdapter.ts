// Capacity adapter: global fallback pools of models per input modality (vision, audio, video).
// Ported from RedRouter v0.33.0 / 9router (open-sse/services/capacityAdapter.js).
//
// When a request carries media that none of a combo's members can take, the operator's pool for
// that modality is put in front of the combo, so the request lands on a model that can read it
// instead of failing closed. A combo that already has a capable member is never touched, an
// enabled pool with no models does nothing (there is no built-in default: pool members cost
// whatever their account costs, so the operator names them), and everything is off unless the
// `capacityAdapter` setting enables it.

import { getResolvedModelCapabilities } from "./modelCapabilities.ts";
import { parseModel } from "./model.ts";
import { containsMediaKind } from "../utils/mediaParts.ts";

export const CAPACITY_MODALITIES = ["vision", "audio", "video"] as const;
export type CapacityModality = (typeof CAPACITY_MODALITIES)[number];

export interface CapacityPool {
  enabled: boolean;
  /** Reserved for a rotating pool; today every pool is an ordered fallback list. */
  roundRobin: boolean;
  models: string[];
}

export type CapacityAdapterSettings = Partial<Record<CapacityModality, unknown>>;

const MEDIA_KIND: Record<CapacityModality, "image" | "audio" | "video"> = {
  vision: "image",
  audio: "audio",
  video: "video",
};

function normalizePool(entry: unknown): CapacityPool {
  if (Array.isArray(entry)) {
    return {
      enabled: true,
      roundRobin: false,
      models: entry
        .map((item) => (typeof item === "string" ? item : (item as { model?: string })?.model))
        .filter((model): model is string => typeof model === "string" && model.length > 0),
    };
  }
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      roundRobin: record.roundRobin === true,
      models: Array.isArray(record.models)
        ? record.models.filter((m): m is string => typeof m === "string" && m.length > 0)
        : [],
    };
  }
  return { enabled: false, roundRobin: false, models: [] };
}

export function getCapacityPool(
  modality: CapacityModality,
  settings: { capacityAdapter?: unknown } | null | undefined
): CapacityPool {
  const all = settings?.capacityAdapter as CapacityAdapterSettings | undefined;
  return normalizePool(all?.[modality]);
}

/** The modalities a request needs that a plain text model could not serve. */
export function requiredModalities(body: Record<string, unknown>): CapacityModality[] {
  const sources = [body.messages, body.input].filter(Array.isArray) as Array<
    Array<{ role?: string; content?: unknown }>
  >;
  return CAPACITY_MODALITIES.filter((modality) =>
    sources.some((messages) => containsMediaKind(messages, MEDIA_KIND[modality]))
  );
}

function supports(modelStr: string, modality: CapacityModality): boolean {
  const parsed = parseModel(modelStr);
  const capabilities = getResolvedModelCapabilities({
    provider: parsed.provider || parsed.providerAlias || null,
    model: parsed.model || modelStr,
  });
  const flag =
    modality === "vision"
      ? capabilities.supportsVision
      : modality === "audio"
        ? capabilities.supportsAudio
        : capabilities.supportsVideo;
  return flag === true;
}

/**
 * The models to try first when the request needs media the given models cannot take. Returns an
 * empty list when nothing is needed, a member already covers every required modality, or no
 * enabled pool has a capable model. Only pools for the modalities the request actually needs are
 * consulted, so an audio pool can never inject a model for an image request.
 */
export function capacityAdapterModels(
  memberModels: readonly string[],
  requirements: readonly CapacityModality[],
  settings: { capacityAdapter?: unknown } | null | undefined
): string[] {
  if (requirements.length === 0 || memberModels.length === 0) return [];
  const covers = (model: string) => requirements.every((need) => supports(model, need));
  if (memberModels.some(covers)) return [];

  const seen = new Set<string>(memberModels);
  const pool: string[] = [];
  for (const need of requirements) {
    const config = getCapacityPool(need, settings);
    if (!config.enabled) continue;
    for (const model of config.models) {
      if (!seen.has(model) && supports(model, need)) {
        seen.add(model);
        pool.push(model);
      }
    }
  }
  // Prefer a model that covers everything asked at once; the rest follow in pool order.
  return [...pool.filter(covers), ...pool.filter((model) => !covers(model))];
}

/** A combo's members as model strings (plain ids or `{ model }` steps); other step kinds are skipped. */
export function comboMemberModelStrings(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models
    .map((step) =>
      typeof step === "string"
        ? step
        : step && typeof step === "object" && typeof (step as { model?: unknown }).model === "string"
          ? ((step as { model: string }).model)
          : null
    )
    .filter((model): model is string => model !== null);
}

/**
 * The combo to run: the same combo with the pool models in front when the request needs media the
 * members cannot take, otherwise the combo unchanged. Pool models join as plain targets, so the
 * combo's own visibility, key policy and fallback rules still apply to them.
 */
export function applyCapacityAdapterToCombo<T extends { models?: unknown }>(
  combo: T,
  body: Record<string, unknown>,
  settings: { capacityAdapter?: unknown } | null | undefined
): { combo: T; added: string[] } {
  const enabled = CAPACITY_MODALITIES.some((m) => getCapacityPool(m, settings).enabled);
  if (!enabled || !Array.isArray(combo.models)) return { combo, added: [] };
  const added = capacityAdapterModels(
    comboMemberModelStrings(combo.models),
    requiredModalities(body),
    settings
  );
  if (added.length === 0) return { combo, added };
  return { combo: { ...combo, models: [...added, ...combo.models] }, added };
}
