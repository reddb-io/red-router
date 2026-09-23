// Recommended models for the accounts a caller has connected, and the combos a
// "recommended setup" creates from them. Pure: it reads /v1/models entries only.
//
// Every choice is deterministic. Candidates are ordered by:
//   1. the family's position in the role's ranking table below;
//   2. the newest version within that family ("claude-opus-5-5" before "claude-opus-5");
//   3. a subscription or free account before a metered API key serving the same
//      model (same family and version: capability-equivalent);
//   4. the shorter id (a base model before its "-thinking" / "-preview" twin);
//   5. catalog order.

/**
 * Ranking tables by model family, matched against the bare model id (the part after
 * the last "/"). Order is the ranking: the first family is the strongest (`default`)
 * or the cheapest capable one (`fast`).
 *
 * default — strongest general coding model:
 *   claude fable > claude opus > gpt-6 sol > gpt-6 astra > gpt-5 flagships
 *   > gemini pro > claude sonnet > grok > kimi > glm > qwen max/coder > deepseek > minimax
 *   (gpt-6 astra is a broad generalist priced well above sol; sol is the coding pick.)
 * fast — cheapest capable fast model:
 *   gpt-6 luna > gemini flash > claude haiku > gpt-5 luna/mini/codex-mini
 *   > grok fast/mini > glm flash/air > qwen flash > deepseek flash > gemini flash-lite
 */
export const RANKINGS = {
  default: [
    { family: "claude-fable", match: /^claude-fable/ },
    { family: "claude-opus", match: /^claude-(?:opus|[\d.-]+-opus)/ },
    { family: "gpt-6-sol", match: /^gpt-6(?:\.\d+)?-sol/ },
    { family: "gpt-6-astra", match: /^gpt-6(?:\.\d+)?-astra/ },
    { family: "gpt-5", match: /^gpt-5(?:\.\d+)?(?:-sol|-pro|-codex(?:-max)?)?$/ },
    { family: "gemini-pro", match: /^gemini-(?:[\d.]+-)?pro/ },
    { family: "claude-sonnet", match: /^claude-(?:sonnet|[\d.-]+-sonnet)/ },
    { family: "grok", match: /^grok-\d+(?:\.\d+)?(?!.*(?:fast|mini))/ },
    { family: "kimi", match: /^kimi-(?:k\d|for-coding)(?!.*highspeed)/ },
    { family: "glm", match: /^glm-\d(?!.*(?:flash|air|turbo|free))/ },
    { family: "qwen", match: /^qwen3(?:\.\d+)?-(?:max|coder|plus)/ },
    { family: "deepseek", match: /^deepseek-(?:v\d+(?:\.\d+)?(?:-pro)?$|r\d|reasoner)/ },
    { family: "minimax", match: /^minimax-m\d/ },
  ],
  fast: [
    { family: "gpt-6-luna", match: /^gpt-6(?:\.\d+)?-luna/ },
    { family: "gemini-flash", match: /^gemini-[\d.]+-flash(?!-lite)/ },
    { family: "claude-haiku", match: /^claude-(?:haiku|[\d.-]+-haiku)/ },
    { family: "gpt-5-small", match: /^gpt-5(?:\.\d+)?-(?:luna|mini|codex-mini|codex-spark)/ },
    { family: "grok-fast", match: /^grok-(?:code-fast|[\d.]+-(?:fast|mini))/ },
    { family: "glm-flash", match: /^glm-[\d.]+-(?:flash|air|turbo)/ },
    { family: "qwen-flash", match: /^qwen[\d.]*-(?:flash|turbo)/ },
    { family: "deepseek-flash", match: /^deepseek-(?:v[\d.]+-flash|chat)/ },
    { family: "gemini-flash-lite", match: /^gemini-[\d.]+-flash-lite/ },
  ],
};

// Never recommended for a chat role, whatever family they belong to.
const EXCLUDED_ID = /(?:image|imagine|tts|embed|transcribe|audio|video|review)/;
const REVIEW_MODE = "review";
const REVIEW_SUFFIX = "-review";
const JEV_ID = /jev/i;

/** The combos a recommended setup creates, in order. */
export const RECOMMENDED_COMBO_ROLES = ["default", "fast", "review"];
const MAX_COMBO_MEMBERS = 3;

/**
 * Recommended models and combo members from one caller's catalog.
 * @param {object[]} models - /v1/models LLM entries (combos are ignored)
 * @param {object[]} [systemOneModels] - /v1/models/systemone entries
 * @returns {{ recommended: object, combos: { name: string, role: string, models: string[], reason: string }[] }}
 */
export function buildRecommendations(models, systemOneModels = []) {
  const entries = models.filter((entry) => entry?.id && entry.provider?.id !== "combo");
  const ranked = {
    default: rankRole(entries, RANKINGS.default),
    fast: rankRole(entries, RANKINGS.fast),
    review: rankReview(entries),
    vision: rankRole(entries.filter((entry) => entry.capabilities?.vision === true), [...RANKINGS.default, ...RANKINGS.fast]),
  };
  const fallback = entries.find((entry) => !EXCLUDED_ID.test(bareId(entry.id)));

  const defaultPick = ranked.default[0]
    ? pick(ranked.default[0], defaultReason(ranked.default))
    : fallback ? pick({ entry: fallback }, "No ranked model family is connected; first model in the catalog.") : null;
  const fastPick = ranked.fast[0]
    ? pick(ranked.fast[0], `Cheapest capable fast model (${ranked.fast[0].family} family)${subscriptionNote(ranked.fast)}.`)
    : defaultPick && { ...defaultPick, reason: "No fast model family is connected; using the default model." };
  const reviewPick = ranked.review[0]
    ? pick(ranked.review[0], `Review mode of ${ranked.review[0].baseName} (${ranked.review[0].family} family).`)
    : defaultPick && { ...defaultPick, reason: "No connected model has a review mode; using the default model." };
  const visionPick = ranked.vision[0]
    ? pick(ranked.vision[0], "Strongest connected model that reads images.")
    : null;
  const jev = systemOneModels.find((entry) => entry?.id && JEV_ID.test(bareId(entry.id))) || systemOneModels.find((entry) => entry?.id);
  const systemOnePick = jev ? pick({ entry: jev }, "First JEV model served on /v1/systemone.") : null;

  const recommended = {
    default: defaultPick,
    fast: fastPick,
    review: reviewPick,
    systemone: systemOnePick,
    ...(visionPick ? { vision: visionPick } : {}),
  };

  const defaultMembers = ranked.default.length ? comboMembers(ranked.default) : defaultPick ? [defaultPick.id] : [];
  const members = {
    default: defaultMembers,
    fast: ranked.fast.length ? comboMembers(ranked.fast) : defaultMembers,
    review: ranked.review.length ? comboMembers(ranked.review) : defaultMembers,
  };
  const combos = RECOMMENDED_COMBO_ROLES
    .filter((role) => members[role].length > 0)
    .map((role) => ({ name: role, role, models: members[role], reason: recommended[role].reason }));

  return { recommended, combos };
}

/**
 * What applying the recommended combos would do to the caller's existing combos:
 * `create` a missing one, `update` one of the same name the caller owns when its
 * members differ, leave it `unchanged` when they match, or `blocked` when the name
 * belongs to a shared combo the caller may not edit. Re-running is idempotent.
 * @param {{ name: string, models: string[] }[]} specs - buildRecommendations().combos
 * @param {object[]} existing - combos visible to the caller
 * @param {{ owner?: string|null, canEditShared?: boolean }} [options]
 */
export function planRecommendedCombos(specs, existing, options = {}) {
  const owner = options.owner ?? null;
  return specs.map((spec) => {
    const sameName = existing.filter((combo) => combo.name === spec.name);
    const own = sameName.find((combo) => (combo.owner ?? null) === owner);
    const shared = sameName.find((combo) => (combo.owner ?? null) === null);
    const target = own || (shared && options.canEditShared ? shared : null);
    if (target) {
      const unchanged = JSON.stringify(target.models || []) === JSON.stringify(spec.models);
      return { ...spec, action: unchanged ? "unchanged" : "update", comboId: target.id, current: target.models || [] };
    }
    if (shared) return { ...spec, action: "blocked", comboId: shared.id, current: shared.models || [] };
    return { ...spec, action: "create" };
  });
}

function rankRole(entries, table) {
  const candidates = entries.flatMap((entry, order) => {
    const id = bareId(entry.id);
    if (EXCLUDED_ID.test(id)) return [];
    const rank = table.findIndex((row) => row.match.test(id));
    if (rank < 0) return [];
    return [{ entry, order, id, rank, family: table[rank].family, version: parseVersion(id) }];
  });
  return candidates.sort(compareCandidates);
}

/**
 * Review candidates: a base entry whose `parameters.modes` includes review (the
 * review variant id is what routes), or a listed "-review" id (?variants=expand).
 * Ranked by the default table, then the fast one, then catalog order.
 */
function rankReview(entries) {
  const table = [...RANKINGS.default, ...RANKINGS.fast];
  const candidates = entries.flatMap((entry, order) => {
    const variant = entry.parameters?.modes?.includes(REVIEW_MODE)
      ? (entry.variants || []).find((v) => v.mode === REVIEW_MODE)
      : null;
    const listedReview = bareId(entry.id).endsWith(REVIEW_SUFFIX) ? entry : null;
    const target = variant ? { ...entry, id: variant.id, name: variant.name || entry.name } : listedReview;
    if (!target) return [];
    const id = bareId(entry.id).replace(/-review$/, "");
    const rank = table.findIndex((row) => row.match.test(id));
    return [{
      entry: target,
      baseName: entry.name || entry.id,
      order,
      id,
      rank: rank < 0 ? table.length : rank,
      family: rank < 0 ? "unranked" : table[rank].family,
      version: parseVersion(id),
    }];
  });
  return candidates.sort(compareCandidates);
}

function compareCandidates(a, b) {
  return a.rank - b.rank
    || compareVersions(b.version, a.version)
    || Number(isSubscription(b.entry)) - Number(isSubscription(a.entry))
    || a.id.length - b.id.length
    || a.order - b.order;
}

/**
 * Members of a recommended combo: the best candidate, then the best one from each
 * other provider (a fallback that survives one provider's outage or quota), then the
 * next best overall, up to MAX_COMBO_MEMBERS.
 */
function comboMembers(ranked) {
  const firstPerProvider = ranked.filter((candidate, index) =>
    ranked.findIndex((other) => providerKey(other.entry) === providerKey(candidate.entry)) === index);
  const ordered = [...firstPerProvider, ...ranked.filter((candidate) => !firstPerProvider.includes(candidate))];
  return [...new Set(ordered.map((candidate) => candidate.entry.id))].slice(0, MAX_COMBO_MEMBERS);
}

function defaultReason(ranked) {
  return `Strongest connected coding model (${ranked[0].family} family, newest version)${subscriptionNote(ranked)}.`;
}

/** Said when a subscription account won over a metered key serving the same model. */
function subscriptionNote(ranked) {
  const [best] = ranked;
  if (!isSubscription(best.entry)) return "";
  const paidTwin = ranked.some((candidate) => candidate.rank === best.rank
    && compareVersions(candidate.version, best.version) === 0
    && !isSubscription(candidate.entry));
  return paidTwin ? "; a subscription account is preferred over a metered API key" : "";
}

function pick(candidate, reason) {
  const entry = candidate.entry;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    provider: { slug: entry.provider?.slug || entry.owned_by || "", name: entry.provider?.name || entry.owned_by || "" },
    reason,
  };
}

function isSubscription(entry) {
  return entry.provider?.subscription === true;
}

// A model served through a remote RedRouter is one account of this instance.
function providerKey(entry) {
  return entry.via || entry.provider?.id || entry.owned_by;
}

function bareId(id) {
  return String(id).slice(String(id).lastIndexOf("/") + 1).toLowerCase();
}

/**
 * [major, minor] of the first version in an id: "claude-opus-5-5" -> [5, 5],
 * "gpt-5.6-sol" -> [5, 6], "claude-opus-4-20250514" -> [4, 0] (a date is not a minor).
 */
export function parseVersion(id) {
  const match = String(id).match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  return match ? [Number(match[1]), Number(match[2] || 0)] : [0, 0];
}

function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}
