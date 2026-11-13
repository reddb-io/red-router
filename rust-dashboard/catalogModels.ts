/** models.dev metadata exposed by the authenticated catalog API. Not entitlements. */
export interface CatalogModel {
  id: string;
  name?: string;
  type?: string;
  canonical_model_id?: string;
  family?: string;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  status?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  open_weights?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
  };
  modalities?: { input: string[]; output: string[] };
  interleaved?: boolean | { field: string };
  reasoning_options?: Array<
    | { type: "toggle" }
    | { type: "effort"; values: Array<string | null> }
    | { type: "budget_tokens"; min?: number; max?: number }
  >;
}

export const catalogCapabilities = {
  reasoning: "Reasoning",
  tool_call: "Tools",
  structured_output: "Structured output",
  attachment: "Attachments",
  temperature: "Temperature",
  open_weights: "Open weights",
} as const;
export type CatalogCapability = keyof typeof catalogCapabilities;
export type CatalogSort = "id" | "context" | "output" | "input-price" | "output-price";
export interface CatalogFilters {
  query: string;
  type: string;
  capability: "" | CatalogCapability;
  inputModality: string;
  minContext: number;
}
export const emptyCatalogFilters: CatalogFilters = {
  query: "",
  type: "",
  capability: "",
  inputModality: "",
  minContext: 0,
};

export function selectCatalogModels(
  models: CatalogModel[],
  filters: CatalogFilters,
  sort: CatalogSort,
  descending: boolean
): CatalogModel[] {
  const query = filters.query.trim().toLowerCase();
  const selected = models.filter((model) => {
    if (filters.type && model.type !== filters.type) return false;
    if (filters.capability && model[filters.capability] !== true) return false;
    if (filters.inputModality && !model.modalities?.input.includes(filters.inputModality))
      return false;
    if (filters.minContext > 0 && (model.limit?.context ?? 0) < filters.minContext) return false;
    const words = [
      model.id,
      model.name,
      model.type,
      model.family,
      model.status,
      model.canonical_model_id,
      ...(model.modalities?.input ?? []),
      ...(model.modalities?.output ?? []),
      ...Object.entries(catalogCapabilities)
        .filter(([key]) => model[key as CatalogCapability] === true)
        .map(([, label]) => label),
    ];
    return words.filter(Boolean).join(" ").toLowerCase().includes(query);
  });
  const value = (model: CatalogModel) =>
    sort === "context"
      ? model.limit?.context
      : sort === "output"
        ? model.limit?.output
        : sort === "input-price"
          ? model.cost?.input
          : model.cost?.output;
  return selected.sort((left, right) => {
    if (sort === "id") return left.id.localeCompare(right.id) * (descending ? -1 : 1);
    const a = value(left),
      b = value(right);
    // Unknown is not zero/free and stays last in either direction.
    if (a == null && b != null) return 1;
    if (a != null && b == null) return -1;
    if (a != null && b != null && a !== b) return (a - b) * (descending ? -1 : 1);
    return left.id.localeCompare(right.id);
  });
}

export function catalogPage(models: CatalogModel[], requested: number) {
  const pageCount = Math.max(1, Math.ceil(models.length / 50));
  const page = Math.max(
    0,
    Math.min(Number.isFinite(requested) ? Math.floor(requested) : 0, pageCount - 1)
  );
  return { page, pageCount, rows: models.slice(page * 50, (page + 1) * 50) };
}
