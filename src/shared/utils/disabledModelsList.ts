/**
 * Global disabled-models gate — port of the legacy fork's `feat/access-control`
 * concept (commit 5ddafeee, `src/lib/modelAccess.js` side that applied to
 * everyone): a model the operator disables must not merely disappear from
 * `/v1/models` — a client that names it still gets refused at dispatch with
 * 403 `model_disabled`, and combo routing skips such members.
 *
 * A settings-backed, opt-in string list (`disabledModels`, default empty =
 * no-op, Hard Rule #20 spirit). Entries are exact ids ("provider/model" or
 * bare "model") or glob patterns (`*`/`?`) via the shared `globToRegex`
 * matcher — the same matching semantics as the exposure list
 * (`modelExposureList.ts`), which stays independent: the exposure list curates
 * advertisement, this list refuses dispatch.
 *
 * The gate is NOT a security boundary — per-key `allowedModels`/`blockedModels`
 * policy (`apiKeyPolicy.ts`) remains the access-control layer. Accordingly, an
 * infra error while reading settings fails OPEN (like the legacy fork's
 * `isModelDisabled` catch), never blocking traffic on a settings hiccup.
 */
import { listMatchesAny } from "./modelExposureList";

export interface DisabledModelsSettings {
  disabledModels?: unknown;
}

export function normalizeDisabledModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** Fast opt-in probe so hot paths skip the matcher entirely when disabled. */
export function hasDisabledModelEntries(
  settings: DisabledModelsSettings | null | undefined
): boolean {
  const list = normalizeDisabledModels(settings?.disabledModels);
  return list.length > 0;
}

function matchesDisabled(list: string[], candidates: string[]): boolean {
  if (list.length === 0) return false;
  return listMatchesAny(list, candidates);
}

/**
 * Whether the (provider, model) pair is globally disabled — used where a
 * resolved provider/model is known (catalog entries, auto/* candidate pools).
 */
export function isModelDisabledGlobally(
  provider: string,
  modelId: string,
  settings: DisabledModelsSettings | null | undefined
): boolean {
  const list = normalizeDisabledModels(settings?.disabledModels);
  if (list.length === 0 || !modelId) return false;
  return matchesDisabled(list, [modelId, `${provider}/${modelId}`]);
}

/**
 * Whether a client-requested model string is globally disabled — used at the
 * dispatch gate where only the requested name is known. The bare model after
 * the first `/` is also a candidate, so a rule on either spelling catches both.
 */
export function isRequestedModelDisabled(
  modelStr: string | null | undefined,
  settings: DisabledModelsSettings | null | undefined
): boolean {
  const list = normalizeDisabledModels(settings?.disabledModels);
  if (list.length === 0 || !modelStr) return false;
  const trimmed = modelStr.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf("/");
  const bare = slash > 0 ? trimmed.slice(slash + 1) : "";
  return matchesDisabled(list, bare ? [trimmed, bare] : [trimmed]);
}
