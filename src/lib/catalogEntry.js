/**
 * The /v1/models entry an id names: its own id, a legacy prefix listed in `aliases`, or
 * the base entry a variant id ("codex/gpt-5.5-review") is folded into.
 */
export function catalogEntryFor(entries, id) {
  return entries.find((entry) => entry.id === id)
    || entries.find((entry) => Array.isArray(entry.aliases) && entry.aliases.includes(id))
    || entries.find((entry) => Array.isArray(entry.variants) && entry.variants.some(
      (variant) => variant.id === id || (Array.isArray(variant.aliases) && variant.aliases.includes(id)),
    ));
}
