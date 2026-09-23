// Pure shape rules for an API key's access policy, shared by the DB layer (which
// stores it) and the router (which enforces it). No imports: the repo loads this.

export const MODEL_ACCESS_MODES = ["all", "allow", "deny"];
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 200;

/** Stored rules, or null when the key is unrestricted. */
export function normalizeModelAccess(value) {
  if (!value || typeof value !== "object") return null;
  const mode = MODEL_ACCESS_MODES.includes(value.mode) ? value.mode : "all";
  if (mode === "all") return null;
  const seen = new Set();
  const patterns = [];
  for (const raw of Array.isArray(value.patterns) ? value.patterns : []) {
    if (typeof raw !== "string") continue;
    const pattern = raw.trim().slice(0, MAX_PATTERN_LENGTH);
    if (!pattern || seen.has(pattern.toLowerCase())) continue;
    seen.add(pattern.toLowerCase());
    patterns.push(pattern);
    if (patterns.length >= MAX_PATTERNS) break;
  }
  // An empty deny list denies nothing; an empty allow list is kept on purpose
  // (a key that may call no model).
  if (mode === "deny" && patterns.length === 0) return null;
  return { mode, patterns };
}

const LIMIT_FIELDS = ["rpm", "tokensPerDay", "usdPerMonth"];

/** Stored limits ({ rpm, tokensPerDay, usdPerMonth }), or null when the key has none. */
export function normalizeKeyLimits(value) {
  if (!value || typeof value !== "object") return null;
  const limits = {};
  for (const field of LIMIT_FIELDS) {
    const n = Number(value[field]);
    if (value[field] === null || value[field] === "" || !Number.isFinite(n) || n <= 0) continue;
    limits[field] = field === "usdPerMonth" ? Math.max(0.01, Math.round(n * 100) / 100) : Math.floor(n);
  }
  return Object.keys(limits).length ? limits : null;
}
