/**
 * Combo pre-dispatch API-key model policy (#9057 / #12886).
 *
 * Policy already admitted the requested combo. Per-target
 * `isModelAllowedForKey` must not then skip every member just because the
 * allow-list is the combo name. auto/* / disableNonPublic still check the
 * inner target so #9057 holds.
 *
 * Also carries the global disabled-models gate (ported from the legacy fork's
 * access-control concept): a target listed in the `disabledModels` settings is
 * skipped BEFORE any per-key logic so a disabled member can never be selected
 * even when the key has no restrictions at all.
 */

import { isModelBlockedByPatterns } from "@/lib/db/apiKeys";
import { isComboNameAllowedForKey } from "@/shared/utils/apiKeyPolicy";
import { isRequestedModelDisabled } from "@/shared/utils/disabledModelsList";
import { getCachedSettings } from "@/lib/db/readCache";

/** Fail-open (legacy behaviour): a settings hiccup must not disable combo fallback. */
async function isTargetDisabledGlobally(targetModelStr: string): Promise<boolean> {
  try {
    const settings = await getCachedSettings();
    return isRequestedModelDisabled(targetModelStr, settings);
  } catch {
    return false;
  }
}

export type ComboTargetKeyPolicyInfo = {
  allowedModels?: string[] | null;
  blockedModels?: string[] | null;
  disableNonPublicModels?: boolean | null;
  modelAccessMode?: string | null;
  allowedCombos?: string[] | null;
};

function modelMatchesAllowPattern(pattern: string, model: string): boolean {
  if (pattern.endsWith("/*")) return model.startsWith(pattern.slice(0, -1));
  return pattern === model;
}

function allowListCoversRequestedCombo(
  allowedModels: string[] | null | undefined,
  requestedModelStr: string
): boolean {
  if (!allowedModels?.length || !requestedModelStr) return false;
  return allowedModels.some((pattern) => modelMatchesAllowPattern(pattern, requestedModelStr));
}

export async function comboTargetPassesKeyModelPolicy(opts: {
  apiKey: string | null | undefined;
  apiKeyInfo: ComboTargetKeyPolicyInfo | null | undefined;
  requestedModelStr: string;
  targetModelStr: string;
  isModelAllowedForKey: (key: string, model: string) => Promise<boolean>;
}): Promise<boolean> {
  const { apiKey, apiKeyInfo, requestedModelStr, targetModelStr, isModelAllowedForKey } = opts;
  if (await isTargetDisabledGlobally(targetModelStr)) return false;
  if (!apiKey || !apiKeyInfo) return true;

  const hasModelRestrictions =
    Boolean(apiKeyInfo.allowedModels?.length) ||
    Boolean(apiKeyInfo.blockedModels?.length) ||
    apiKeyInfo.disableNonPublicModels === true;
  if (!hasModelRestrictions) return true;

  const explicitlyAllowedCombo =
    !requestedModelStr.startsWith("auto/") &&
    Array.isArray(apiKeyInfo.allowedCombos) &&
    isComboNameAllowedForKey(apiKeyInfo.allowedCombos, requestedModelStr);
  if (explicitlyAllowedCombo) return true;

  if (await isModelBlockedByPatterns(apiKeyInfo.blockedModels, targetModelStr)) return false;

  if (allowListCoversRequestedCombo(apiKeyInfo.allowedModels, requestedModelStr)) {
    return true;
  }

  return isModelAllowedForKey(apiKey, targetModelStr);
}
