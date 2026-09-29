// Recommended models for the accounts a caller has connected, and the combos a
// "recommended setup" creates from them. Pure: it reads /v1/models entries only.
// Ported from RedRouter v0.33.0 (src/lib/modelRecommendations.js).
//
// Every choice is deterministic. Candidates are ordered by:
//   1. the family's position in the role's ranking table below;
//   2. the newest version within that family ("claude-opus-5-5" before "claude-opus-5");
//   3. a subscription or free account before a metered API key serving the same
//      model (same family and version: capability-equivalent);
//   4. the shorter id (a base model before its "-thinking" / "-preview" twin);
//   5. catalog order.

export interface RecommendationProvider {
  id?: string;
  slug?: string;
  name?: string;
  /** True for a subscription (OAuth) account, false for a metered API key. */
  subscription?: boolean;
}

/** A /v1/models entry reduced to what the recommendations read. */
export interface RecommendationModel {
  id: string;
  name?: string;
  owned_by?: string;
  /** A model served through a remote RedRouter is one account of this instance. */
  via?: string;
  provider?: RecommendationProvider;
  capabilities?: { vision?: boolean } & Record<string, unknown>;
  parameters?: { modes?: string[] };
  variants?: Array<{ id: string; name?: string; mode?: string }>;
}

export interface RecommendedPick {
  id: string;
  name: string;
  provider: { slug: string; name: string };
  reason: string;
}

export type RecommendedRole = "default" | "fast" | "review";

export interface Recommendations {
  default: RecommendedPick | null;
  fast: RecommendedPick | null;
  review: RecommendedPick | null;
  systemone: RecommendedPick | null;
  vision?: RecommendedPick;
}

export interface RecommendedComboSpec {
  name: RecommendedRole;
  role: RecommendedRole;
  models: string[];
  reason: string;
}

export type RecommendedComboAction = "create" | "update" | "unchanged" | "blocked";

export interface RecommendedComboPlanItem extends RecommendedComboSpec {
  action: RecommendedComboAction;
  comboId?: string;
  /** Members of the combo an `update` replaces (or the current members when unchanged). */
  current?: string[];
  /** Why a `blocked` item cannot be applied. */
  blockedReason?: string;
}

interface RankRow {
  family: string;
  match: RegExp;
}

interface Candidate {
  entry: RecommendationModel;
  order: number;
  id: string;
  rank: number;
  family: string;
  version: [number, number];
  baseName?: string;
}

/**
 * Ranking tables by model family, matched against the bare model id (the part after
 * the last "/"). Order is the ranking: the first family is the strongest (`default`)
 * or the cheapest capable one (`fast`).
 *
 * default: strongest general coding model:
 *   claude fable > claude opus > gpt-6 sol > gpt-6 astra > gpt-5 flagships
 *   > gemini pro > claude sonnet > grok > kimi > glm > qwen max/coder > deepseek > minimax
 *   (gpt-6 astra is a broad generalist priced well above sol; sol is the coding pick.)
 * fast: cheapest capable fast model:
 *   gpt-6 luna > gemini flash > claude haiku > gpt-5 luna/mini/codex-mini
 *   > grok fast/mini > glm flash/air > qwen flash > deepseek flash > gemini flash-lite
 */
export const RANKINGS: { default: RankRow[]; fast: RankRow[] } = {
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
export const RECOMMENDED_COMBO_ROLES: readonly RecommendedRole[] = ["default", "fast", "review"];
const MAX_COMBO_MEMBERS = 3;

/**
 * Recommended models and combo members from one caller's catalog.
 * @param models /v1/models LLM entries (combos are ignored)
 * @param systemOneModels /v1/models/systemone entries
 */
export function buildRecommendations(
  models: RecommendationModel[],
  systemOneModels: RecommendationModel[] = []
): { recommended: Recommendations; combos: RecommendedComboSpec[] } {
  const entries = models.filter((entry) => entry?.id && entry.provider?.id !== "combo");
  const ranked = {
    default: rankRole(entries, RANKINGS.default),
    fast: rankRole(entries, RANKINGS.fast),
    review: rankReview(entries),
    vision: rankRole(
      entries.filter((entry) => entry.capabilities?.vision === true),
      [...RANKINGS.default, ...RANKINGS.fast]
    ),
  };
  const fallback = entries.find((entry) => !EXCLUDED_ID.test(bareId(entry.id)));

  const defaultPick: RecommendedPick | null = ranked.default[0]
    ? pick(ranked.default[0], defaultReason(ranked.default))
    : fallback
      ? pick(
          { entry: fallback },
          "No ranked model family is connected; first model in the catalog."
        )
      : null;
  const fastPick: RecommendedPick | null = ranked.fast[0]
    ? pick(
        ranked.fast[0],
        `Cheapest capable fast model (${ranked.fast[0].family} family)${subscriptionNote(ranked.fast)}.`
      )
    : defaultPick && {
        ...defaultPick,
        reason: "No fast model family is connected; using the default model.",
      };
  const reviewPick: RecommendedPick | null = ranked.review[0]
    ? pick(
        ranked.review[0],
        `Review mode of ${ranked.review[0].baseName} (${ranked.review[0].family} family).`
      )
    : defaultPick && {
        ...defaultPick,
        reason: "No connected model has a review mode; using the default model.",
      };
  const visionPick = ranked.vision[0]
    ? pick(ranked.vision[0], "Strongest connected model that reads images.")
    : null;
  const jev =
    systemOneModels.find((entry) => entry?.id && JEV_ID.test(bareId(entry.id))) ||
    systemOneModels.find((entry) => entry?.id);
  const systemOnePick = jev
    ? pick({ entry: jev }, "First JEV model served on /v1/systemone.")
    : null;

  const recommended: Recommendations = {
    default: defaultPick,
    fast: fastPick,
    review: reviewPick,
    systemone: systemOnePick,
    ...(visionPick ? { vision: visionPick } : {}),
  };

  const defaultMembers = ranked.default.length
    ? comboMembers(ranked.default)
    : defaultPick
      ? [defaultPick.id]
      : [];
  const members: Record<RecommendedRole, string[]> = {
    default: defaultMembers,
    fast: ranked.fast.length ? comboMembers(ranked.fast) : defaultMembers,
    review: ranked.review.length ? comboMembers(ranked.review) : defaultMembers,
  };
  const combos = RECOMMENDED_COMBO_ROLES.filter((role) => members[role].length > 0).map(
    (role): RecommendedComboSpec => ({
      name: role,
      role,
      models: members[role],
      reason: recommended[role]?.reason ?? "",
    })
  );

  return { recommended, combos };
}

/** A role no connected account can serve. It is reported, never silently dropped. */
export const NO_ACCOUNT_REASON = "No connected account can serve this role.";

/**
 * What applying the recommended combos would do to the caller's existing combos:
 * `create` a missing one, `update` one of the same name when its members differ,
 * leave it `unchanged` when they match, or `blocked` when no connected account can
 * serve the role. Re-running is idempotent.
 * @param specs buildRecommendations().combos
 * @param existing combos visible to the caller; `models` may be plain ids or combo steps
 * @param sameMembers compares two member lists (defaults to strict list equality)
 */
export function planRecommendedCombos(
  specs: RecommendedComboSpec[],
  existing: Array<{ id?: unknown; name?: unknown; models?: unknown }>,
  options: { memberIds?: (models: unknown) => string[] } = {}
): RecommendedComboPlanItem[] {
  const memberIds = options.memberIds ?? defaultMemberIds;
  const plan: RecommendedComboPlanItem[] = [];
  const planned = new Set<string>();
  for (const spec of specs) {
    planned.add(spec.name);
    const target = existing.find((combo) => combo.name === spec.name);
    if (!target) {
      plan.push({ ...spec, action: "create" });
      continue;
    }
    const current = memberIds(target.models);
    const unchanged = JSON.stringify(current) === JSON.stringify(memberIds(spec.models));
    plan.push({
      ...spec,
      action: unchanged ? "unchanged" : "update",
      comboId: String(target.id),
      current,
    });
  }
  for (const role of RECOMMENDED_COMBO_ROLES) {
    if (planned.has(role)) continue;
    const target = existing.find((combo) => combo.name === role);
    plan.push({
      name: role,
      role,
      models: [],
      reason: NO_ACCOUNT_REASON,
      action: "blocked",
      blockedReason: NO_ACCOUNT_REASON,
      ...(target ? { comboId: String(target.id), current: memberIds(target.models) } : {}),
    });
  }
  return plan;
}

function defaultMemberIds(models: unknown): string[] {
  return Array.isArray(models)
    ? models.filter((item): item is string => typeof item === "string")
    : [];
}

function rankRole(entries: RecommendationModel[], table: RankRow[]): Candidate[] {
  const candidates = entries.flatMap((entry, order): Candidate[] => {
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
function rankReview(entries: RecommendationModel[]): Candidate[] {
  const table = [...RANKINGS.default, ...RANKINGS.fast];
  const candidates = entries.flatMap((entry, order): Candidate[] => {
    const variant = entry.parameters?.modes?.includes(REVIEW_MODE)
      ? (entry.variants || []).find((v) => v.mode === REVIEW_MODE)
      : null;
    const listedReview = bareId(entry.id).endsWith(REVIEW_SUFFIX) ? entry : null;
    const target = variant
      ? { ...entry, id: variant.id, name: variant.name || entry.name }
      : listedReview;
    if (!target) return [];
    const id = bareId(entry.id).replace(/-review$/, "");
    const rank = table.findIndex((row) => row.match.test(id));
    return [
      {
        entry: target,
        baseName: entry.name || entry.id,
        order,
        id,
        rank: rank < 0 ? table.length : rank,
        family: rank < 0 ? "unranked" : table[rank].family,
        version: parseVersion(id),
      },
    ];
  });
  return candidates.sort(compareCandidates);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.rank - b.rank ||
    compareVersions(b.version, a.version) ||
    Number(isSubscription(b.entry)) - Number(isSubscription(a.entry)) ||
    a.id.length - b.id.length ||
    a.order - b.order
  );
}

/**
 * Members of a recommended combo: the best candidate, then the best one from each
 * other provider (a fallback that survives one provider's outage or quota), then the
 * next best overall, up to MAX_COMBO_MEMBERS.
 */
function comboMembers(ranked: Candidate[]): string[] {
  const firstPerProvider = ranked.filter(
    (candidate, index) =>
      ranked.findIndex((other) => providerKey(other.entry) === providerKey(candidate.entry)) ===
      index
  );
  const ordered = [
    ...firstPerProvider,
    ...ranked.filter((candidate) => !firstPerProvider.includes(candidate)),
  ];
  return [...new Set(ordered.map((candidate) => candidate.entry.id))].slice(0, MAX_COMBO_MEMBERS);
}

function defaultReason(ranked: Candidate[]): string {
  return `Strongest connected coding model (${ranked[0].family} family, newest version)${subscriptionNote(ranked)}.`;
}

/** Said when a subscription account won over a metered key serving the same model. */
function subscriptionNote(ranked: Candidate[]): string {
  const [best] = ranked;
  if (!isSubscription(best.entry)) return "";
  const paidTwin = ranked.some(
    (candidate) =>
      candidate.rank === best.rank &&
      compareVersions(candidate.version, best.version) === 0 &&
      !isSubscription(candidate.entry)
  );
  return paidTwin ? "; a subscription account is preferred over a metered API key" : "";
}

function pick(candidate: { entry: RecommendationModel }, reason: string): RecommendedPick {
  const entry = candidate.entry;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    provider: {
      slug: entry.provider?.slug || entry.owned_by || "",
      name: entry.provider?.name || entry.owned_by || "",
    },
    reason,
  };
}

function isSubscription(entry: RecommendationModel): boolean {
  return entry.provider?.subscription === true;
}

// A model served through a remote RedRouter is one account of this instance.
function providerKey(entry: RecommendationModel): string | undefined {
  return entry.via || entry.provider?.id || entry.owned_by;
}

function bareId(id: string): string {
  return String(id)
    .slice(String(id).lastIndexOf("/") + 1)
    .toLowerCase();
}

/**
 * [major, minor] of the first version in an id: "claude-opus-5-5" -> [5, 5],
 * "gpt-5.6-sol" -> [5, 6], "claude-opus-4-20250514" -> [4, 0] (a date is not a minor).
 */
export function parseVersion(id: string): [number, number] {
  const match = String(id).match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  return match ? [Number(match[1]), Number(match[2] || 0)] : [0, 0];
}

function compareVersions(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

// ---------------------------------------------------------------------------
// Adapter over OmniRoute's combo-builder catalog
// ---------------------------------------------------------------------------
// `getComboBuilderOptions()` (src/lib/combos/builderOptions.ts) already lists, per
// provider, the caller's connections and the models a combo step can name (its
// `qualifiedModel` is the routable id). The recommendations read that shape instead
// of a second catalog: these interfaces are the structural subset they need.

export interface CatalogConnection {
  id: string;
  /** provider_connections.auth_type: oauth / apikey / cookie / ... */
  type?: string;
  isActive?: boolean;
}

export interface CatalogModel {
  id: string;
  qualifiedModel: string;
  name?: string;
  supportedEndpoints?: string[];
}

export interface CatalogProvider {
  providerId: string;
  displayName?: string;
  alias?: string;
  connections: CatalogConnection[];
  models: CatalogModel[];
}

export interface CatalogAdapterOptions {
  /** A key's `allowedConnections`: only those connections feed the recommendations. */
  allowedConnectionIds?: readonly string[] | null;
  /** True when the connection is a subscription/free plan rather than a metered API key. */
  isSubscription?: (providerId: string, connection: CatalogConnection) => boolean;
  /** True when the model reads images. */
  isVision?: (modelId: string) => boolean;
}

/** A combo-builder connection id can pin one fingerprint of a row: `<rowId>|fp|<fingerprint>`. */
function connectionRowId(id: string): string {
  const cut = id.indexOf("|fp|");
  return cut < 0 ? id : id.slice(0, cut);
}

export interface ConnectedProvider {
  provider: CatalogProvider;
  identity: RecommendationProvider;
}

/**
 * The providers the caller has connected: an active connection the caller may use.
 * A provider with no connection (a no-auth provider, a static catalog entry) is not
 * "connected" and feeds nothing.
 */
export function connectedProviders(
  providers: CatalogProvider[],
  options: CatalogAdapterOptions = {}
): ConnectedProvider[] {
  const allowed = options.allowedConnectionIds?.length
    ? new Set(options.allowedConnectionIds)
    : null;
  const result: ConnectedProvider[] = [];
  for (const provider of providers) {
    const usable = provider.connections.filter(
      (connection) =>
        connection.isActive !== false &&
        (!allowed || allowed.has(connection.id) || allowed.has(connectionRowId(connection.id)))
    );
    if (usable.length === 0) continue;
    const subscription = usable.some((connection) =>
      options.isSubscription
        ? options.isSubscription(provider.providerId, connection)
        : connection.type === "oauth"
    );
    result.push({
      provider,
      identity: {
        id: provider.providerId,
        slug: provider.alias || provider.providerId,
        name: provider.displayName || provider.providerId,
        subscription,
      },
    });
  }
  return result;
}

const EFFORT_SUFFIX = /-(?:minimal|low|medium|high|xhigh|none|nothink)$/;

/** The chat models of the connected providers, as recommendation entries. */
export function toRecommendationModels(
  connected: ConnectedProvider[],
  options: Pick<CatalogAdapterOptions, "isVision"> = {}
): RecommendationModel[] {
  const entries: RecommendationModel[] = [];
  for (const { provider, identity } of connected) {
    const ids = new Set(provider.models.map((model) => model.id));
    for (const model of provider.models) {
      if (model.supportedEndpoints?.length && !model.supportedEndpoints.includes("chat")) continue;
      // The catalog expands a reasoning-effort variant ("-low", "-high", ...) next to its
      // base model; the base is the one worth naming in a combo.
      if (EFFORT_SUFFIX.test(model.id) && ids.has(model.id.replace(EFFORT_SUFFIX, ""))) continue;
      entries.push({
        id: model.qualifiedModel,
        name: model.name || model.id,
        owned_by: identity.slug,
        provider: identity,
        ...(options.isVision?.(model.id) ? { capabilities: { vision: true } } : {}),
      });
    }
  }
  return entries;
}

/** A System One model of the registry (`getAllSystemOneModels()`). */
export interface SystemOneCatalogModel {
  id: string;
  provider: string;
  name?: string;
}

/** System One models whose provider the caller has connected, for the `systemone` pick. */
export function toSystemOneModels(
  models: SystemOneCatalogModel[],
  connected: ConnectedProvider[]
): RecommendationModel[] {
  const identities = new Map(connected.map(({ identity }) => [identity.id, identity]));
  return models
    .filter((model) => identities.has(model.provider))
    .map((model) => {
      const provider = identities.get(model.provider);
      return { id: model.id, name: model.name || model.id, owned_by: provider?.slug, provider };
    });
}
