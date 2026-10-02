/** Existing catalog/routing regressions explicitly select their fixture inventory. */
export async function activateFixtureModels(provider: string, modelIds: readonly string[]) {
  const { readCompatList, writeCompatList } = await import("../../src/lib/db/models/compat.ts");
  const rows = readCompatList(provider);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let changed = false;
  for (const id of modelIds) {
    const row = byId.get(id);
    if (typeof row?.isHidden === "boolean") continue;
    byId.set(id, { ...row, id, isHidden: false });
    changed = true;
  }
  if (changed) writeCompatList(provider, [...byId.values()]);
}

export async function activateCatalogFixtureInventory() {
  const { getProviderConnections } = await import("../../src/lib/db/providers.ts");
  const { getAllCustomModels, getAllSyncedAvailableModels } =
    await import("../../src/lib/db/models.ts");
  const { getSettings } = await import("../../src/lib/db/settings.ts");
  const { getModelsByProviderId } = await import("../../src/shared/constants/models.ts");
  const connections = await getProviderConnections();
  const settings = await getSettings();
  const providers = new Set(connections.map((connection) => String(connection.provider)));
  for (const id of (settings.enabledNoAuthProviders as string[] | undefined) || [])
    providers.add(id);
  const custom = await getAllCustomModels();
  const synced = await getAllSyncedAvailableModels();
  for (const provider of providers) {
    const customRows = Array.isArray(custom[provider]) ? custom[provider] : [];
    const discovered = synced[provider] || [];
    const modelIds = [
      ...getModelsByProviderId(provider).map((model) => model.id),
      "search",
      "fetch",
      ...customRows
        .filter((row) => !!row && typeof row === "object" && typeof row.id === "string")
        .map((row) => row.id),
      ...discovered.map((model) => model.id),
    ];
    await activateFixtureModels(provider, modelIds);
  }
}

/** Explicit combo targets are selected by the catalog fixture's operator too. */
export async function activateFixtureComboTargets() {
  const { getCombos } = await import("../../src/lib/db/combos.ts");
  for (const combo of await getCombos()) {
    for (const target of combo.models || []) {
      const fullModel = typeof target === "string" ? target : target.model;
      if (typeof fullModel !== "string") continue;
      const slash = fullModel.indexOf("/");
      if (slash > 0)
        await activateFixtureModels(fullModel.slice(0, slash), [fullModel.slice(slash + 1)]);
    }
  }
}
