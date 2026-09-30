/**
 * What the provider page's "Settings" panel shows for a connection, and what "Reset to defaults" may
 * remove. Pure functions: the panel and its tests share them.
 *
 * "Defaults" means the connection's own OVERRIDES of a provider's initial configuration (its
 * destination, group tag, routing tags, excluded models). Credentials and the fields a provider needs
 * to work at all (an Azure resource, a Modal endpoint with no default host) are never reset.
 */

type JsonRecord = Record<string, unknown>;

export const RESETTABLE_KEYS = ["baseUrl", "tag", "tags", "excludedModels"] as const;
export type ResettableKey = (typeof RESETTABLE_KEYS)[number];

export interface ConfigRow {
  key: ResettableKey;
  label: string;
  /** What is in effect now. */
  value: string;
  /** What "Reset to defaults" would put back (empty = the field is simply cleared). */
  defaultValue: string;
  /** Set by the operator, i.e. differs from the provider's initial configuration. */
  overridden: boolean;
  /** Reset is allowed: overridden AND clearing it leaves a working connection. */
  resettable: boolean;
}

export interface ConfigContext {
  /** The provider's built-in destination; empty when it has none (the operator must supply it). */
  defaultBaseUrl: string;
  /** The provider has a first-class destination field (so the row shows even with the default). */
  baseUrlConfigurable: boolean;
}

interface ConnectionLike {
  providerSpecificData?: unknown;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => text(item))
      .filter(Boolean)
      .join(", ");
  }
  return text(value);
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** The rows worth showing: the destination (when it applies) and any override that is set. */
export function connectionConfigRows(
  connection: ConnectionLike,
  context: ConfigContext
): ConfigRow[] {
  const psd = record(connection.providerSpecificData);
  const rows: ConfigRow[] = [];

  const baseUrl = text(psd.baseUrl);
  const differsFromDefault =
    baseUrl !== "" &&
    (context.defaultBaseUrl === "" || trimSlash(baseUrl) !== trimSlash(context.defaultBaseUrl));
  if (context.baseUrlConfigurable || baseUrl !== "") {
    rows.push({
      key: "baseUrl",
      label: "Destination",
      value: baseUrl || context.defaultBaseUrl,
      defaultValue: context.defaultBaseUrl,
      overridden: differsFromDefault,
      // A provider with no built-in host cannot fall back to anything: clearing it would break it.
      resettable: differsFromDefault && context.defaultBaseUrl !== "",
    });
  }

  const optional: Array<[ResettableKey, string, string]> = [
    ["tag", "Group tag", text(psd.tag)],
    ["tags", "Routing tags", list(psd.tags)],
    ["excludedModels", "Excluded models", list(psd.excludedModels)],
  ];
  for (const [key, label, value] of optional) {
    if (!value) continue;
    rows.push({ key, label, value, defaultValue: "", overridden: true, resettable: true });
  }
  return rows;
}

export function resettableKeys(
  connection: ConnectionLike,
  context: ConfigContext
): ResettableKey[] {
  return connectionConfigRows(connection, context)
    .filter((row) => row.resettable)
    .map((row) => row.key);
}

export function hasOverrides(connection: ConnectionLike, context: ConfigContext): boolean {
  return resettableKeys(connection, context).length > 0;
}

/**
 * The PUT body that resets `keys`. The endpoint merges `providerSpecificData` (keys not sent are kept),
 * so a reset sends `null` for each key: every reader treats null as "not set" and falls back to the
 * provider's default. Keys outside the resettable list are refused, never sent.
 */
export function buildResetBody(keys: readonly string[]): {
  providerSpecificData: Record<string, null>;
} {
  const allowed = new Set<string>(RESETTABLE_KEYS);
  const data: Record<string, null> = {};
  for (const key of keys) {
    if (allowed.has(key)) data[key] = null;
  }
  return { providerSpecificData: data };
}

/** One line per thing a reset would change, for the confirmation. */
export function describeReset(
  rows: readonly ConfigRow[],
  keys: readonly ResettableKey[]
): string[] {
  const chosen = new Set<string>(keys);
  return rows
    .filter((row) => chosen.has(row.key))
    .map((row) =>
      row.defaultValue
        ? `${row.label}: ${row.value} → ${row.defaultValue}`
        : `${row.label}: ${row.value} → cleared`
    );
}
