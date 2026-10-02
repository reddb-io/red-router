/**
 * Modality-scoped model visibility (#12172) — the single precedence rule shared by the
 * DB layer (public catalog / combo candidate pools) and the dashboard UI.
 *
 * A `modelCompatOverrides` row may hide a model either everywhere (the legacy top-level
 * `isHidden`) or for one endpoint/modality only (`hiddenModalities[endpoint]`), which is
 * what lets an operator hide a Chat model without also suppressing an identically-ID'd
 * model in another registry (e.g. Image). Keeping one implementation here is deliberate:
 * the rule used to be duplicated, and the dashboard kept reading the legacy flag after the
 * write path was scoped, so hides silently stopped showing up in the UI.
 *
 * Pure — no imports, safe in both server and client bundles.
 */

export type ModelHiddenFlags = {
  isHidden?: boolean;
  hiddenModalities?: Record<string, boolean> | null;
};

/**
 * Resolve whether a compat-override row hides its model for a given modality.
 * An explicit `hiddenModalities[modality]` entry always wins; otherwise the legacy
 * all-modalities `isHidden` flag applies. Without an explicit false flag, the model
 * is inactive: discovery, pricing and compatibility metadata never opt in.
 */
export function isHiddenForModality(
  flags: ModelHiddenFlags | null | undefined,
  modality: string = "chat"
): boolean {
  const scoped = flags?.hiddenModalities?.[modality];
  if (scoped !== undefined) return Boolean(scoped);
  return flags?.isHidden !== false;
}

/** Explicit activation state, bulk-loaded once for catalog and candidate builders. */
export type ModelActivationSnapshot = Map<string, Map<string, boolean>>;

/** Exact model decisions win over parameter aliases; explicit deactivation wins across keys. */
export function isModelHiddenInSnapshot(
  snapshot: ModelActivationSnapshot,
  providerKeys: readonly (string | null | undefined)[],
  modelIds: readonly string[]
): boolean {
  for (const modelId of modelIds) {
    let activated = false;
    for (const key of providerKeys) {
      if (!key) continue;
      const decision = snapshot.get(key)?.get(modelId);
      if (decision === true) return true;
      if (decision === false) activated = true;
    }
    if (activated) return false;
  }
  return true;
}
