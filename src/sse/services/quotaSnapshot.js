// Quota-aware account selection. A background tick reads each active account's
// quota from the provider's usage API (the same call the dashboard makes) and
// keeps the last report in memory; account selection then skips accounts whose
// quota is used up, keeps a reserve on the rest, and prefers the account whose
// window resets first (its quota is lost at reset if unused).
// Opt-in (settings.quotaAwareRouting): the tick costs one usage call per account.
import { isQuotaExhausted } from "open-sse/services/usage/quota.js";

export const QUOTA_SNAPSHOT_TTL_MS = 30 * 60_000;   // older reports count as unknown
export const QUOTA_REFRESH_MS = 5 * 60_000;
export const DEFAULT_QUOTA_RESERVE_PERCENT = 0;

const g = (globalThis.__rrQuotaSnapshots ??= { byConnection: new Map(), interval: null, running: false });

/** Remember a usage report ({ quotas }) for an account; the dashboard's reads feed this too. */
export function recordQuotaSnapshot(connectionId, usage, now = Date.now()) {
  const quotas = usage?.quotas;
  if (!connectionId || !quotas || typeof quotas !== "object" || Object.keys(quotas).length === 0) return;
  g.byConnection.set(connectionId, { at: now, quotas });
}

export function getQuotaSnapshot(connectionId, now = Date.now()) {
  const snap = g.byConnection.get(connectionId);
  if (!snap || now - snap.at > QUOTA_SNAPSHOT_TTL_MS) return null;
  return snap;
}

// Words that tie a quota window to a model family ("weekly Opus (7d)"). A window
// naming a family the requested model is not part of does not apply to it.
const FAMILY_WORDS = new Set([
  "opus", "sonnet", "haiku", "claude", "gemini", "flash", "pro", "gpt", "codex",
  "grok", "kimi", "glm", "qwen", "deepseek", "minimax", "gpt5", "o3", "o4",
]);

export function quotaAppliesToModel(name, model) {
  const words = String(name || "").toLowerCase().split(/[^a-z0-9.]+/).filter((w) => FAMILY_WORDS.has(w));
  if (words.length === 0) return true;
  if (!model) return false;
  const id = String(model).toLowerCase();
  return words.some((w) => id.includes(w));
}

function toNumber(value) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Fraction of a window still available (0..1), or null when the report has no numbers. */
export function remainingFraction(quota) {
  if (!quota || quota.unlimited === true) return null;
  const total = toNumber(quota.total);
  if (total === null || total <= 0) return null;
  const remaining = toNumber(quota.remaining);
  if (remaining !== null) return Math.max(0, Math.min(1, remaining / total));
  const used = toNumber(quota.used);
  return used === null ? null : Math.max(0, Math.min(1, 1 - used / total));
}

/**
 * What the snapshot says about an account for a model: { known, exhausted,
 * tightest (lowest remaining fraction), resetAtMs (of the tightest window) }.
 */
export function quotaStanding(connectionId, model, now = Date.now()) {
  const snap = getQuotaSnapshot(connectionId, now);
  if (!snap) return { known: false, exhausted: false, tightest: null, resetAtMs: null };
  let exhausted = false;
  let tightest = null;
  let resetAtMs = null;
  for (const [name, quota] of Object.entries(snap.quotas)) {
    if (!quotaAppliesToModel(name, model)) continue;
    const resetMs = quota?.resetAt ? Date.parse(quota.resetAt) : NaN;
    // A window whose reset already passed is fresh again, whatever it said.
    if (Number.isFinite(resetMs) && resetMs <= now) continue;
    if (isQuotaExhausted(quota)) exhausted = true;
    const fraction = remainingFraction(quota);
    if (fraction !== null && (tightest === null || fraction < tightest)) {
      tightest = fraction;
      resetAtMs = Number.isFinite(resetMs) ? resetMs : null;
    }
  }
  return { known: true, exhausted, tightest, resetAtMs };
}

/**
 * Order accounts for a model by quota: exhausted ones are dropped (unless that
 * would drop them all — the upstream then has the last word), accounts under the
 * reserve go last, and among the rest the one whose tightest window resets first
 * leads. Accounts with no fresh report keep their place among the healthy ones.
 */
export function orderByQuota(connections, model, { reservePercent = DEFAULT_QUOTA_RESERVE_PERCENT, now = Date.now() } = {}) {
  const standing = connections.map((conn, index) => ({ conn, index, ...quotaStanding(conn.id, model, now) }));
  const usable = standing.filter((s) => !s.exhausted);
  if (usable.length === 0) return connections;
  const reserve = Math.max(0, Math.min(100, Number(reservePercent) || 0)) / 100;
  const underReserve = (s) => reserve > 0 && s.tightest !== null && s.tightest < reserve;
  usable.sort((a, b) =>
    (underReserve(a) - underReserve(b))
    || ((a.resetAtMs ?? Infinity) - (b.resetAtMs ?? Infinity))
    || (a.index - b.index));
  return usable.map((s) => s.conn);
}

/** Test hook. */
export function resetQuotaSnapshots() {
  g.byConnection.clear();
}

export { g as quotaSnapshotState };
