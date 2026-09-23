// The dashboard's "recommended setup": preview and apply the default, fast and review
// combos RedRouter recommends for the connected accounts. Applying is idempotent: a
// combo of the same name the caller owns is updated in place, never duplicated.
import { getCombos, createCombo, updateCombo } from "@/lib/localDb";
import { recommendedComboSpecs } from "@/lib/catalog.js";
import { planRecommendedCombos } from "@/lib/modelRecommendations.js";
import { resetComboRotation } from "open-sse/services/combo.js";

/**
 * What a recommended setup would do for one caller.
 * @param {{ scopeFilter?: object|null, owner?: string|null, canEditShared?: boolean, hidden?: Set<string> }} viewer
 *   scopeFilter as for buildModelsList; owner stamps new combos; hidden shared combo names
 *   the caller hid (their names are free to reuse).
 */
export async function previewRecommendedCombos(viewer = {}) {
  const { recommended, combos: specs } = await recommendedComboSpecs({ scopeFilter: viewer.scopeFilter });
  const owner = viewer.owner ?? null;
  const hidden = viewer.hidden || new Set();
  const existing = (await getCombos()).filter((combo) => {
    const comboOwner = combo.owner ?? null;
    if (comboOwner === null) return !hidden.has(combo.name);
    return comboOwner === owner;
  });
  const items = planRecommendedCombos(specs, existing, { owner, canEditShared: viewer.canEditShared === true });
  return { recommended, items };
}

/**
 * Create or update the recommended combos. `names` limits the run to those combos.
 * @returns {Promise<{ recommended: object, items: object[], created: object[], updated: object[], unchanged: string[], skipped: string[] }>}
 */
export async function applyRecommendedCombos(viewer = {}, names = null) {
  const { recommended, items } = await previewRecommendedCombos(viewer);
  const selected = Array.isArray(names) ? items.filter((item) => names.includes(item.name)) : items;
  const result = { recommended, items: selected, created: [], updated: [], unchanged: [], skipped: [] };
  for (const item of selected) {
    if (item.action === "create") {
      result.created.push(await createCombo({ name: item.name, models: item.models, owner: viewer.owner ?? null }));
    } else if (item.action === "update") {
      const combo = await updateCombo(item.comboId, { models: item.models });
      resetComboRotation(item.name);
      result.updated.push(combo);
    } else if (item.action === "unchanged") {
      result.unchanged.push(item.name);
    } else {
      result.skipped.push(item.name);
    }
  }
  return result;
}
