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
  // These regressions inject custom-catalog read failures; fixture preparation
  // must still select the independent static inventory before testing that path.
  const [customResult, syncedResult] = await Promise.allSettled([
    getAllCustomModels(),
    getAllSyncedAvailableModels(),
  ]);
  const custom = customResult.status === "fulfilled" ? customResult.value : {};
  const synced = syncedResult.status === "fulfilled" ? syncedResult.value : {};
  const { getCompatibleFallbackModels } =
    await import("../../src/lib/providers/managedAvailableModels.ts");
  const { getStaticModelsForProvider } = await import("../../src/lib/providers/staticModels.ts");
  const { getImageProvider } = await import("../../open-sse/config/imageRegistry.ts");
  const { getVideoProvider } = await import("../../open-sse/config/videoRegistry.ts");
  const { getMusicProvider } = await import("../../open-sse/config/musicRegistry.ts");
  const { getModerationProvider } = await import("../../open-sse/config/moderationRegistry.ts");
  const { CODEX_NATIVE_UNPREFIXED_MODELS } = await import("../../open-sse/services/model.ts");
  for (const provider of providers) {
    const customRows = Array.isArray(custom[provider]) ? custom[provider] : [];
    const discovered = synced[provider] || [];
    const modelIds = [
      ...(provider === "codex" ? [...CODEX_NATIVE_UNPREFIXED_MODELS] : []),
      ...getModelsByProviderId(provider).map((model) => model.id),
      ...(getCompatibleFallbackModels(provider) || [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === "string"),
      ...(getStaticModelsForProvider(provider) || []).map((model) => model.id),
      ...(getImageProvider(provider)?.models || []).map((model: { id: string }) => model.id),
      ...(getVideoProvider(provider)?.models || []).map((model) => model.id),
      ...(getMusicProvider(provider)?.models || []).map((model) => model.id),
      ...(getModerationProvider(provider)?.models || []).map((model) => model.id),
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
  const { getProviderAlias, resolveProviderId } =
    await import("../../src/shared/constants/providers.ts");
  for (const combo of await getCombos()) {
    for (const target of combo.models || []) {
      const fullModel = typeof target === "string" ? target : target.model;
      if (typeof fullModel !== "string") continue;
      const slash = fullModel.indexOf("/");
      const explicitProvider = typeof target === "object" ? target.providerId : undefined;
      if (typeof explicitProvider === "string" && explicitProvider.length > 0) {
        const provider = resolveProviderId(explicitProvider);
        const prefix = slash > 0 ? fullModel.slice(0, slash) : "";
        const model =
          prefix === provider || prefix === getProviderAlias(provider)
            ? fullModel.slice(slash + 1)
            : fullModel;
        await activateFixtureModels(provider, [model]);
      } else if (slash > 0) {
        await activateFixtureModels(resolveProviderId(fullModel.slice(0, slash)), [
          fullModel.slice(slash + 1),
        ]);
      }
    }
  }
}
