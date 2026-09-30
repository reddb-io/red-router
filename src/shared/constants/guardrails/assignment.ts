/**
 * Guardrail assignment: which guardrails apply to a request, in which order.
 *
 * Settings shape (`guardrailAssignments`):
 *   global:  [{ id, enabled, priority }]        defaults for every request
 *   byGroup: { <keyGroupId>: { disabled, enabled } }   overrides for keys in a group
 *   byKey:   { <keyId>:      { disabled, enabled } }   overrides for one key; wins over groups
 *
 * `resolveGuardrails` is pure: settings in, ordered list out. Precedence is global, then each
 * group in the order given, then the key. Inside one scope a guardrail listed as both disabled
 * and enabled is disabled. A guardrail that can rewrite traffic (`mutatesData`) is only ever
 * enabled by an explicit `enabled` entry; a catalog default never turns it on.
 */

import { GUARDRAIL_CATALOG, type GuardrailCatalogEntry } from "./catalog";

export const GUARDRAIL_PRIORITY_MAX = 1000;
export const GUARDRAIL_ASSIGNMENT_MAX_SCOPES = 1000;

export interface GuardrailGlobalAssignment {
  id: string;
  enabled: boolean;
  priority: number;
}

export interface GuardrailScopeOverride {
  disabled: string[];
  enabled: string[];
}

export interface GuardrailAssignments {
  global: GuardrailGlobalAssignment[];
  byKey: Record<string, GuardrailScopeOverride>;
  byGroup: Record<string, GuardrailScopeOverride>;
}

export type GuardrailResolutionSource = "default" | "global" | "group" | "key";

export interface ResolvedGuardrail {
  id: string;
  enabled: boolean;
  priority: number;
  /** Widest scope that decided the enabled state. */
  source: GuardrailResolutionSource;
  mutatesData: boolean;
}

export function emptyGuardrailAssignments(): GuardrailAssignments {
  return { global: [], byKey: {}, byGroup: {} };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function normalizeOverrides(value: unknown): Record<string, GuardrailScopeOverride> {
  const out: Record<string, GuardrailScopeOverride> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  for (const [scopeId, raw] of Object.entries(value as Record<string, unknown>).slice(
    0,
    GUARDRAIL_ASSIGNMENT_MAX_SCOPES
  )) {
    if (!scopeId || scopeId === "__proto__" || !raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    out[scopeId] = { disabled: stringList(record.disabled), enabled: stringList(record.enabled) };
  }
  return out;
}

/** Reads the stored setting defensively; anything malformed degrades to "no assignments". */
export function normalizeGuardrailAssignments(raw: unknown): GuardrailAssignments {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyGuardrailAssignments();
  const record = raw as Record<string, unknown>;
  const global: GuardrailGlobalAssignment[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.global)) {
    for (const item of record.global) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const priority =
        typeof entry.priority === "number" && Number.isFinite(entry.priority)
          ? Math.min(GUARDRAIL_PRIORITY_MAX, Math.max(0, Math.trunc(entry.priority)))
          : (GUARDRAIL_CATALOG.find((item) => item.id === entry.id)?.defaultPriority ?? 100);
      global.push({ id: entry.id, enabled: entry.enabled === true, priority });
    }
  }
  return {
    global,
    byKey: normalizeOverrides(record.byKey),
    byGroup: normalizeOverrides(record.byGroup),
  };
}

export function hasGuardrailAssignments(assignments: GuardrailAssignments): boolean {
  return (
    assignments.global.length > 0 ||
    Object.keys(assignments.byKey).length > 0 ||
    Object.keys(assignments.byGroup).length > 0
  );
}

interface Scratch {
  enabled: boolean;
  explicit: boolean;
  priority: number;
  source: GuardrailResolutionSource;
}

function ownEntry(
  map: Record<string, GuardrailScopeOverride>,
  id: string
): GuardrailScopeOverride | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

function applyOverride(
  state: Scratch,
  id: string,
  override: GuardrailScopeOverride | undefined,
  source: GuardrailResolutionSource
) {
  if (!override || !Array.isArray(override.disabled) || !Array.isArray(override.enabled)) return;
  if (override.disabled.includes(id)) {
    state.enabled = false;
    state.explicit = false;
    state.source = source;
  } else if (override.enabled.includes(id)) {
    state.enabled = true;
    state.explicit = true;
    state.source = source;
  }
}

export function resolveGuardrails({
  keyId,
  groupIds = [],
  assignments,
  catalog = GUARDRAIL_CATALOG,
}: {
  keyId?: string | null;
  groupIds?: readonly string[];
  assignments?: GuardrailAssignments | null;
  catalog?: readonly GuardrailCatalogEntry[];
}): ResolvedGuardrail[] {
  const config = assignments ?? emptyGuardrailAssignments();
  const globals = new Map(config.global.map((entry) => [entry.id, entry]));

  const resolved = catalog.map((entry): ResolvedGuardrail => {
    const state: Scratch = {
      enabled: entry.defaultEnabled,
      explicit: false,
      priority: entry.defaultPriority,
      source: "default",
    };

    const global = globals.get(entry.id);
    if (global) {
      state.enabled = global.enabled;
      state.explicit = global.enabled;
      state.source = "global";
      state.priority = global.priority;
    }
    for (const groupId of groupIds) {
      applyOverride(state, entry.id, ownEntry(config.byGroup, groupId), "group");
    }
    if (keyId) applyOverride(state, entry.id, ownEntry(config.byKey, keyId), "key");

    // A data-changing guardrail is never on by inheritance or by catalog default.
    const enabled = entry.mutatesData ? state.enabled && state.explicit : state.enabled;
    return {
      id: entry.id,
      enabled,
      priority: state.priority,
      source: state.source,
      mutatesData: entry.mutatesData,
    };
  });

  return resolved.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
