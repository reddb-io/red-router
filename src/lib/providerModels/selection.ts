import {
  filterCatalogCapabilities,
  withCatalogRoleCapabilities,
  type CatalogCapability,
} from "@/app/api/v1/models/catalogCapabilities";

export interface ModelSelectionRow extends Record<string, unknown> {
  id: string;
  fullModel: string;
  name: string;
}

/** Keep the connection's remote identity intact, including every federation hop. */
export function projectConnectionModels(
  provider: string,
  prefix: string,
  rows: readonly Record<string, unknown>[],
  capabilities: readonly CatalogCapability[]
): ModelSelectionRow[] {
  const projected = new Map<string, ModelSelectionRow>();
  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id) continue;
    const fullModel =
      provider === "red-router"
        ? `red/${row.id}`
        : row.id.startsWith(`${prefix}/`)
          ? row.id
          : `${prefix}/${row.id}`;
    const model = withCatalogRoleCapabilities({
      ...row,
      id: fullModel,
      root: row.id,
      owned_by: provider,
      supported_endpoints: row.supported_endpoints ?? row.supportedEndpoints,
    });
    projected.set(fullModel, {
      ...model,
      id: row.id,
      fullModel,
      name: typeof row.name === "string" ? row.name : row.id,
    });
  }
  // Filtering needs the same public id/root pair as /v1/models.
  return [...projected.values()].filter(
    (row) => filterCatalogCapabilities([{ ...row, id: row.fullModel }], capabilities).length > 0
  );
}
