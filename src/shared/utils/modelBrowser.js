// Filtering, sorting and presets for the provider page's model browser. Pure
// functions over the models /api/models/browse returns, so they are testable
// without a DOM and cheap to re-run on every keystroke.

const DAY_MS = 24 * 60 * 60 * 1000;

export const CONTEXT_OPTIONS = [
  { value: 0, label: "Any context" },
  { value: 32_000, label: "≥ 32k" },
  { value: 128_000, label: "≥ 128k" },
  { value: 200_000, label: "≥ 200k" },
  { value: 400_000, label: "≥ 400k" },
  { value: 1_000_000, label: "≥ 1M" },
];

export const RELEASED_OPTIONS = [
  { value: 0, label: "Any time" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 3 months" },
  { value: 180, label: "Last 6 months" },
  { value: 365, label: "Last year" },
];

export const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "context", label: "Largest context" },
  { value: "cheapest", label: "Cheapest" },
  { value: "name", label: "Name" },
];

// Capability toggles: each one keeps only the models that have it.
export const CAPABILITY_FLAGS = [
  { key: "reasoning", label: "Reasoning", icon: "psychology" },
  { key: "tools", label: "Tools", icon: "build" },
  { key: "vision", label: "Vision", icon: "image" },
  { key: "free", label: "Free", icon: "money_off" },
  { key: "openWeights", label: "Open weights", icon: "lock_open" },
];

export const DEFAULT_FILTERS = {
  query: "",
  vendor: "",
  minContext: 0,
  releasedWithinDays: 0,
  flags: {},
  sort: "newest",
};

// One click to a useful list. "Recommended" is what most people want from a
// new provider: recent, agent-capable (tools) models with room to work.
export const PRESETS = [
  { id: "recommended", label: "Recommended", icon: "auto_awesome", filters: { flags: { tools: true }, minContext: 128_000, releasedWithinDays: 365, sort: "newest" } },
  { id: "newest", label: "Newest", icon: "new_releases", filters: { sort: "newest" } },
  { id: "free", label: "Free", icon: "money_off", filters: { flags: { free: true }, sort: "context" } },
  { id: "reasoning", label: "Reasoning", icon: "psychology", filters: { flags: { reasoning: true }, sort: "newest" } },
  { id: "long-context", label: "Long context", icon: "width_full", filters: { minContext: 400_000, sort: "context" } },
  { id: "cheapest", label: "Cheapest", icon: "savings", filters: { flags: { tools: true }, sort: "cheapest" } },
  { id: "open", label: "Open weights", icon: "lock_open", filters: { flags: { openWeights: true }, sort: "newest" } },
];

export function presetFilters(presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  return { ...DEFAULT_FILTERS, ...(preset?.filters || {}), flags: { ...(preset?.filters?.flags || {}) } };
}

// Blended price per million tokens (3:1 input:output, the usual chat mix).
export function blendedCost(model) {
  const c = model?.cost;
  if (!c || (c.input == null && c.output == null)) return null;
  return ((c.input ?? c.output) * 3 + (c.output ?? c.input)) / 4;
}

function matchesQuery(model, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${model.id} ${model.name || ""} ${model.vendor || ""} ${model.family || ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Models matching `filters`, sorted. `now` (ms) is injectable for tests. */
export function filterModels(models, filters = DEFAULT_FILTERS, { now = Date.now() } = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const since = f.releasedWithinDays > 0 ? new Date(now - f.releasedWithinDays * DAY_MS).toISOString().slice(0, 10) : null;
  const out = (models || []).filter((m) => {
    if (m.textOutput === false) return false; // image/audio generators live on the media pages
    if (f.vendor && m.vendor !== f.vendor) return false;
    if (f.minContext > 0 && !(m.contextWindow >= f.minContext)) return false;
    if (since && !(m.releaseDate && m.releaseDate >= since)) return false;
    for (const [flag, on] of Object.entries(f.flags || {})) {
      if (on && !m[flag]) return false;
    }
    return matchesQuery(m, f.query);
  });
  return sortModels(out, f.sort);
}

export function sortModels(models, sort = "newest") {
  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id));
  const cmp = {
    newest: (a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")) || byName(a, b),
    context: (a, b) => (b.contextWindow || 0) - (a.contextWindow || 0) || byName(a, b),
    // Unknown prices go last: "cheapest" should not surface models we know nothing about.
    cheapest: (a, b) => {
      const ca = blendedCost(a), cb = blendedCost(b);
      if (ca == null && cb == null) return byName(a, b);
      if (ca == null) return 1;
      if (cb == null) return -1;
      return ca - cb || byName(a, b);
    },
    name: byName,
  }[sort] || byName;
  return [...models].sort(cmp);
}

/** Owners with model counts, most models first — the vendor dropdown. */
export function vendorFacets(models) {
  const counts = new Map();
  for (const m of models || []) {
    if (m.textOutput === false || !m.vendor) continue;
    counts.set(m.vendor, (counts.get(m.vendor) || 0) + 1);
  }
  return [...counts.entries()].map(([vendor, count]) => ({ vendor, count })).sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

export function formatTokens(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function formatCost(model) {
  if (model?.free) return "Free";
  const c = model?.cost;
  if (!c || (c.input == null && c.output == null)) return null;
  const fmt = (v) => (v == null ? "?" : v < 0.01 && v > 0 ? v.toFixed(3) : +v.toFixed(2));
  return `$${fmt(c.input)} / $${fmt(c.output)}`;
}
