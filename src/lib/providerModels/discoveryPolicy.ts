/** RedRouter restores automatic discovery; other providers keep explicit opt-in. */
export function shouldAutoSyncModels(provider: unknown, data: Record<string, unknown>): boolean {
  if (provider === "red-router") return data.autoFetchModels !== false && data.autoSync !== false;
  return data.autoSync === true;
}

export function applyRemoteRouterDiscoveryDefaults(
  provider: unknown,
  data: Record<string, unknown>
) {
  if (provider !== "red-router") return data;
  return {
    ...data,
    autoFetchModels: data.autoFetchModels ?? true,
    autoSync: data.autoSync ?? data.autoFetchModels !== false,
  };
}
