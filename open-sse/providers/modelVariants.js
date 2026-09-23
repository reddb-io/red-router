// Variant model ids — a thinking level or a mode baked into the id ("gemini-3.8-flash-high",
// "gpt-5.5-review", "claude-opus-5-thinking") — and the base model they fold into on
// /v1/models. Variant ids keep routing as they always did; a base id with a level
// ("gemini-3.8-flash(high)") routes to the variant that serves that level.

// Per-model level tables, for models whose levels are different upstream models.
// `default` is the level a bare base id routes to when the base is not a model itself.
export const LEVEL_VARIANTS = {
  antigravity: {
    "gemini-3.8-flash": {
      name: "Gemini 3.8 Flash",
      levels: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" },
    },
    "gemini-3.7-flash": {
      name: "Gemini 3.7 Flash",
      default: "medium",
      levels: { low: "gemini-3.7-flash-low", medium: "gemini-3.7-flash-medium", high: "gemini-3.7-flash-high" },
    },
    "gemini-3.6-flash": {
      name: "Gemini 3.6 Flash",
      default: "medium",
      levels: { low: "gemini-3.6-flash-low", medium: "gemini-3.6-flash-medium", high: "gemini-3.6-flash-high" },
    },
  },
  "grok-cli": {
    "grok-4.5": {
      name: "Grok 4.5",
      levels: { low: "grok-4.5-low", medium: "grok-4.5-medium", high: "grok-4.5-high" },
    },
  },
};

// Suffix families: "<base><suffix>" is a variant of "<base>" when both are listed (live
// catalogs make these per account). A level-and-mode suffix comes before its parts.
export const SUFFIX_VARIANTS = {
  codex: [{ suffix: "-review", mode: "review" }],
  kiro: [
    { suffix: "-thinking-agentic", level: "thinking", mode: "agentic" },
    { suffix: "-thinking", level: "thinking" },
    { suffix: "-agentic", mode: "agentic" },
  ],
  cursor: [{ suffix: "-thinking", level: "thinking" }],
};

// Canonical level order for a base entry's merged thinking_levels.
const LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "thinking"];
const LEVEL_SUFFIX_RE = /^(.*)\(([^()]+)\)\s*$/;

/**
 * The variants among one provider's listed ids, grouped by the base id they fold into:
 * Map<base, [{ id, level?, mode? }]>. A table base may be absent from `ids` (it is not
 * a model of its own); the catalog then lists it in place of its variants.
 */
export function groupModelVariants(providerId, ids) {
  const listed = new Set(ids);
  const groups = new Map();
  const add = (base, variant) => groups.set(base, [...(groups.get(base) || []), variant]);
  for (const [base, family] of Object.entries(LEVEL_VARIANTS[providerId] || {})) {
    for (const [level, id] of Object.entries(family.levels)) {
      if (id !== base && listed.has(id)) add(base, { id, level });
    }
  }
  const claimed = new Set([...groups.values()].flat().map((variant) => variant.id));
  const rules = SUFFIX_VARIANTS[providerId] || [];
  for (const id of ids) {
    if (claimed.has(id)) continue;
    const rule = rules.find((r) => id.endsWith(r.suffix) && listed.has(id.slice(0, -r.suffix.length)));
    if (!rule) continue;
    add(id.slice(0, -rule.suffix.length), {
      id,
      ...(rule.level ? { level: rule.level } : {}),
      ...(rule.mode ? { mode: rule.mode } : {}),
    });
  }
  return groups;
}

/** Display name of a table base that is not a model of its own. */
export function variantBaseName(providerId, base) {
  return LEVEL_VARIANTS[providerId]?.[base]?.name || null;
}

/** The base's own levels plus the levels its variants add, in canonical order. */
export function mergeVariantLevels(levels, variants) {
  const merged = new Set([...(levels || []), ...variants.map((v) => v.level).filter(Boolean)]);
  if (merged.size === 0) return null;
  const rank = (level) => (LEVEL_ORDER.includes(level) ? LEVEL_ORDER.indexOf(level) : LEVEL_ORDER.length);
  return [...merged].sort((a, b) => rank(a) - rank(b));
}

/**
 * The model id to call for a requested one. A base id with a level ("grok-4.5(high)"),
 * or a bare table base with a default level, becomes the variant that serves it; any
 * other id (variant ids included) is returned unchanged.
 */
export function resolveVariantRequest(providerId, model) {
  if (typeof model !== "string") return model;
  const match = model.match(LEVEL_SUFFIX_RE);
  const base = match ? match[1].trim() : model;
  const level = match ? match[2].trim().toLowerCase() : null;
  const family = LEVEL_VARIANTS[providerId]?.[base];
  if (family) return family.levels[level ?? family.default] || model;
  if (!level) return model;
  const rules = SUFFIX_VARIANTS[providerId] || [];
  // A variant that already carries a level keeps the id the client picked.
  if (rules.some((r) => r.level && base.endsWith(r.suffix))) return model;
  // "claude-opus-5-agentic(thinking)" -> "claude-opus-5-thinking-agentic"
  const modeRule = rules.find((r) => r.mode && !r.level && base.endsWith(r.suffix));
  const root = modeRule ? base.slice(0, -modeRule.suffix.length) : base;
  const rule = rules.find((r) => r.level === level && r.mode === modeRule?.mode);
  return rule ? `${root}${rule.suffix}` : model;
}
