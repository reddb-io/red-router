// The dashboard's "recommended setup": preview and apply the default, fast and review
// combos RedRouter recommends for the connected accounts. Applying is idempotent: a
// combo of the same name is updated in place, never duplicated. Ported from RedRouter
// v0.33.0 (src/lib/recommendedCombos.js) on top of OmniRoute's own modules:
//   - the connected-account model catalog is `getComboBuilderOptions()` (combo builder),
//   - subscription vs metered comes from the auto-combo connection-billing classifier,
//   - vision from `modelIdLikelyVision`, System One from the System One registry,
//   - combos are written through `src/lib/db/combos.ts` (validateComboInvariant /
//     normalizeComboRecord run in its repository).
// Everything that touches the DB or the catalog is behind `RecommendedCombosDeps`, so the
// preview/apply semantics are unit-testable with fixtures.

import { getComboModelString, normalizeComboModels } from "@/lib/combos/steps";
import {
  buildRecommendations,
  connectedProviders,
  planRecommendedCombos,
  toRecommendationModels,
  toSystemOneModels,
  type CatalogProvider,
  type RecommendationModel,
  type Recommendations,
  type RecommendedComboPlanItem,
  type RecommendedComboSpec,
  type SystemOneCatalogModel,
} from "@/lib/modelRecommendations";

/**
 * The caller. Only the accounts the caller may use feed the recommendations: an API key
 * with `allowedConnections` sees just those connections; the dashboard session (or an
 * unrestricted key) sees every active connection.
 */
export interface RecommendationViewer {
  allowedConnectionIds?: readonly string[] | null;
}

type ComboLike = Record<string, unknown> & { id?: unknown; name?: unknown; models?: unknown };

export interface RecommendationCatalog {
  models: RecommendationModel[];
  systemOne: RecommendationModel[];
}

export interface RecommendedCombosDeps {
  loadCatalog(viewer: RecommendationViewer): Promise<RecommendationCatalog>;
  listCombos(): Promise<ComboLike[]>;
  createCombo(data: ComboLike): Promise<ComboLike>;
  updateCombo(id: string, data: ComboLike): Promise<ComboLike | null>;
}

export interface RecommendedComboPreview {
  recommended: Recommendations;
  items: RecommendedComboPlanItem[];
}

export interface RecommendedComboApplyResult extends RecommendedComboPreview {
  created: ComboLike[];
  updated: ComboLike[];
  unchanged: string[];
  skipped: string[];
}

/** Ids of a combo's members, comparable across plain ids and normalized combo steps. */
export function comboMemberIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return normalizeComboModels(models).map(
    (step) => getComboModelString(step) ?? `${step.kind}:${JSON.stringify(step)}`
  );
}

/** What a recommended setup would do for one caller. */
export async function previewRecommendedCombos(
  viewer: RecommendationViewer = {},
  deps: RecommendedCombosDeps = defaultDeps
): Promise<RecommendedComboPreview> {
  const catalog = await deps.loadCatalog(viewer);
  const { recommended, combos } = buildRecommendations(catalog.models, catalog.systemOne);
  const items = planRecommendedCombos(combos as RecommendedComboSpec[], await deps.listCombos(), {
    memberIds: comboMemberIds,
  });
  return { recommended, items };
}

/**
 * Create or update the recommended combos. `names` limits the run to those combos.
 * A `blocked` role (no connected account can serve it) is reported under `skipped`.
 */
export async function applyRecommendedCombos(
  viewer: RecommendationViewer = {},
  names: string[] | null = null,
  deps: RecommendedCombosDeps = defaultDeps
): Promise<RecommendedComboApplyResult> {
  const { recommended, items } = await previewRecommendedCombos(viewer, deps);
  const selected = Array.isArray(names) ? items.filter((item) => names.includes(item.name)) : items;
  const result: RecommendedComboApplyResult = {
    recommended,
    items: selected,
    created: [],
    updated: [],
    unchanged: [],
    skipped: [],
  };
  for (const item of selected) {
    if (item.action === "create") {
      result.created.push(await deps.createCombo({ name: item.name, models: item.models }));
    } else if (item.action === "update" && item.comboId) {
      const combo = await deps.updateCombo(item.comboId, { models: item.models });
      if (combo) result.updated.push(combo);
      else result.skipped.push(item.name);
    } else if (item.action === "unchanged") {
      result.unchanged.push(item.name);
    } else {
      result.skipped.push(item.name);
    }
  }
  return result;
}

/** Count of plan items by action, as the API reports them next to the items. */
export function summarizeRecommendedItems(items: RecommendedComboPlanItem[]) {
  const count = (action: RecommendedComboPlanItem["action"]) =>
    items.filter((item) => item.action === action).length;
  return {
    toCreate: count("create"),
    toUpdate: count("update"),
    unchanged: count("unchanged"),
    blocked: count("blocked"),
  };
}

/** The caller's scope from the credentials of a management request, if it carries an API key. */
export async function viewerFromRequest(request: Request): Promise<RecommendationViewer> {
  const [{ extractApiKey }, { getApiKeyMetadata }] = await Promise.all([
    import("@/sse/services/auth"),
    import("@/lib/db/apiKeys"),
  ]);
  const apiKey = extractApiKey(request);
  if (!apiKey) return {};
  const metadata = await getApiKeyMetadata(apiKey);
  const allowed = metadata?.allowedConnections;
  return { allowedConnectionIds: Array.isArray(allowed) && allowed.length > 0 ? allowed : null };
}

async function loadCatalog(viewer: RecommendationViewer): Promise<RecommendationCatalog> {
  const [{ getComboBuilderOptions }, capabilities, billing, systemOne] = await Promise.all([
    import("@/lib/combos/builderOptions"),
    import("@/lib/modelCapabilities"),
    import("@omniroute/open-sse/services/autoCombo/connectionBilling"),
    import("@omniroute/open-sse/config/systemOneRegistry"),
  ]);
  const { providers } = await getComboBuilderOptions();
  const connected = connectedProviders(providers as CatalogProvider[], {
    allowedConnectionIds: viewer.allowedConnectionIds,
    isSubscription: (providerId, connection) =>
      connection.type === "oauth" ||
      billing.isPlanIncluded(
        billing.classifyConnectionBilling({ provider: providerId, authType: connection.type })
      ),
  });
  return {
    models: toRecommendationModels(connected, { isVision: capabilities.modelIdLikelyVision }),
    systemOne: toSystemOneModels(
      systemOne.getAllSystemOneModels() as SystemOneCatalogModel[],
      connected
    ),
  };
}

const defaultDeps: RecommendedCombosDeps = {
  loadCatalog,
  async listCombos() {
    const { getCombos } = await import("@/lib/db/combos");
    return (await getCombos()) as ComboLike[];
  },
  async createCombo(data) {
    const { createCombo } = await import("@/lib/db/combos");
    return (await createCombo(data)) as ComboLike;
  },
  async updateCombo(id, data) {
    const { updateCombo } = await import("@/lib/db/combos");
    return (await updateCombo(id, data)) as ComboLike | null;
  },
};
