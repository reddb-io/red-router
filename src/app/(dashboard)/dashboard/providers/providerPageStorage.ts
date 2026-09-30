export const SHOW_CONFIGURED_ONLY_STORAGE_KEY = "omniroute-providers-show-configured-only";
export const PROVIDER_DISPLAY_MODE_STORAGE_KEY = "omniroute-providers-display-mode";

export type ProviderDisplayMode = "all" | "configured" | "compact";

/** Which slice of the catalogue the providers page shows: what is on, the free sources, or everything. */
export const PROVIDER_VIEW_STORAGE_KEY = "redrouter-providers-view";
export type ProviderView = "enabled" | "free" | "all";
export const PROVIDER_VIEWS: readonly ProviderView[] = ["enabled", "free", "all"];
/** Opt-in: the page opens on what the operator turned on, never on the whole catalogue. */
export const DEFAULT_PROVIDER_VIEW: ProviderView = "enabled";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter extends StorageReader {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageReaderWriter = StorageReader & Partial<StorageWriter>;

export function parseConfiguredOnlyPreference(value: string | null | undefined): boolean {
  return value === "true";
}

export function parseProviderDisplayModePreference(
  value: string | null | undefined
): ProviderDisplayMode | null {
  if (value === "all" || value === "configured" || value === "compact") return value;

  return null;
}

function getBrowserStorage(): StorageWriter | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readConfiguredOnlyPreference(storage: StorageReader | null = getBrowserStorage()) {
  if (!storage) return false;

  return parseConfiguredOnlyPreference(storage.getItem(SHOW_CONFIGURED_ONLY_STORAGE_KEY));
}

export function writeConfiguredOnlyPreference(
  enabled: boolean,
  storage: StorageWriter | null = getBrowserStorage()
) {
  if (!storage) return;

  if (enabled) {
    storage.setItem(SHOW_CONFIGURED_ONLY_STORAGE_KEY, "true");
    return;
  }

  storage.removeItem(SHOW_CONFIGURED_ONLY_STORAGE_KEY);
}

export function readProviderDisplayModePreference(
  storage: StorageReaderWriter | null = getBrowserStorage()
): ProviderDisplayMode {
  if (!storage) return "all";

  const storedMode = parseProviderDisplayModePreference(
    storage.getItem(PROVIDER_DISPLAY_MODE_STORAGE_KEY)
  );
  if (storedMode) return storedMode;

  if (!readConfiguredOnlyPreference(storage)) return "all";

  storage.setItem?.(PROVIDER_DISPLAY_MODE_STORAGE_KEY, "configured");
  storage.removeItem?.(SHOW_CONFIGURED_ONLY_STORAGE_KEY);
  return "configured";
}

export function writeProviderDisplayModePreference(
  mode: ProviderDisplayMode,
  storage: StorageWriter | null = getBrowserStorage()
) {
  if (!storage) return;

  storage.removeItem(SHOW_CONFIGURED_ONLY_STORAGE_KEY);

  if (mode === "all") {
    storage.removeItem(PROVIDER_DISPLAY_MODE_STORAGE_KEY);
    return;
  }

  storage.setItem(PROVIDER_DISPLAY_MODE_STORAGE_KEY, mode);
}

/**
 * Gate for the provider display-mode persistence effects. They must NOT run while the
 * connections fetch is still in flight (`loading`), or they would coerce a saved
 * "configured" preference to "all" against an empty connections list before the real
 * data arrives — silently dropping the user's filter across reloads (#5510). Returns
 * true only once the stored preference has been read (`ready`) AND loading has settled.
 */
export function shouldSyncProviderDisplayMode(ready: boolean, loading: boolean): boolean {
  return ready && !loading;
}

/** Anything that is not one of the three known views (corrupt or stale storage) is rejected. */
export function parseProviderViewPreference(value: unknown): ProviderView | null {
  return value === "enabled" || value === "free" || value === "all" ? value : null;
}

/**
 * The stored view, or the default. Storage may be missing, blocked or throwing (private windows,
 * cleared site data), so every access is guarded; the page must work without it.
 */
export function readProviderViewPreference(
  storage: StorageReader | null = getBrowserStorage()
): ProviderView {
  if (!storage) return DEFAULT_PROVIDER_VIEW;
  try {
    return (
      parseProviderViewPreference(storage.getItem(PROVIDER_VIEW_STORAGE_KEY)) ??
      DEFAULT_PROVIDER_VIEW
    );
  } catch {
    return DEFAULT_PROVIDER_VIEW;
  }
}

export function writeProviderViewPreference(
  view: ProviderView,
  storage: StorageWriter | null = getBrowserStorage()
): void {
  if (!storage) return;
  try {
    if (view === DEFAULT_PROVIDER_VIEW) storage.removeItem(PROVIDER_VIEW_STORAGE_KEY);
    else storage.setItem(PROVIDER_VIEW_STORAGE_KEY, view);
  } catch {
    // Persistence is a convenience; the selected view still applies for this visit.
  }
}
