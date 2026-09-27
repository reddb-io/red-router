import { resolveProviderId } from "@/shared/constants/providers";
import { isFreeModel } from "@/shared/utils/freeModels";

import type { CatalogModel, LegacyCatalogHealth } from "./legacyCatalogTools";

export interface LegacyHealthConnection {
  id: string;
  provider: string;
  isActive: boolean;
  rateLimitedUntil: string | null;
  testStatus: string | null;
}

export interface LegacyHealthSignals {
  modelLock(
    provider: string,
    connectionId: string,
    model: string
  ): {
    reason: string;
    remainingMs: number;
  } | null;
  quotaExhausted(connectionId: string, provider: string, model: string): boolean;
}

function connectionHealth(
  connection: LegacyHealthConnection,
  model: string,
  now: number,
  signals: LegacyHealthSignals
): LegacyCatalogHealth {
  if (!connection.isActive) return { status: { state: "disabled" }, usable: false };
  const status = connection.testStatus?.toLowerCase();
  if (
    status === "credits_exhausted" &&
    !(
      resolveProviderId(connection.provider) === "openrouter" &&
      isFreeModel("openrouter", { id: model })
    )
  ) {
    return { status: { state: "quota_exhausted" }, usable: false };
  }
  if (status === "banned" || status === "expired") {
    return { status: { state: "unavailable" }, usable: false };
  }
  const cooldown = connection.rateLimitedUntil ? Date.parse(connection.rateLimitedUntil) : NaN;
  if (cooldown > now) {
    return {
      status: { state: "rate_limited", until: new Date(cooldown).toISOString() },
      usable: false,
    };
  }
  const lock = signals.modelLock(connection.provider, connection.id, model);
  if (lock && lock.remainingMs > 0) {
    return {
      status: {
        state: lock.reason === "quota_exhausted" ? "quota_exhausted" : "unavailable",
        until: new Date(now + lock.remainingMs).toISOString(),
      },
      usable: false,
    };
  }
  if (signals.quotaExhausted(connection.id, connection.provider, model)) {
    return { status: { state: "quota_exhausted" }, usable: false };
  }
  if (status === "active" || status === "success") {
    return { status: { state: "ok" }, usable: true };
  }
  return { status: { state: "unknown" }, usable: null };
}

/** Scope first, then read model-level health. No account names or secrets leave this boundary. */
export function buildLegacyCatalogHealth(
  models: CatalogModel[],
  connections: LegacyHealthConnection[],
  allowedConnectionIds: Set<string> | null,
  signals: LegacyHealthSignals,
  now = Date.now()
): Record<string, LegacyCatalogHealth> {
  const scoped = connections.filter((connection) =>
    allowedConnectionIds ? allowedConnectionIds.has(connection.id) : true
  );
  const byProvider = new Map<string, LegacyHealthConnection[]>();
  for (const connection of scoped) {
    const provider = resolveProviderId(connection.provider);
    const accounts = byProvider.get(provider) ?? [];
    accounts.push(connection);
    byProvider.set(provider, accounts);
  }
  const result: Record<string, LegacyCatalogHealth> = {};
  for (const entry of models) {
    if (!entry.owned_by || entry.owned_by === "combo" || entry.owned_by === "alias") {
      result[entry.id] = { status: { state: "unknown" }, usable: null };
      continue;
    }
    const owner = resolveProviderId(entry.owned_by);
    const model = entry.id.startsWith(`${entry.owned_by}/`)
      ? entry.id.slice(entry.owned_by.length + 1)
      : entry.id;
    const accounts = byProvider.get(owner) ?? [];
    if (accounts.length === 0) {
      result[entry.id] = { status: { state: "unknown" }, usable: null };
      continue;
    }
    const states = accounts.map((connection) => connectionHealth(connection, model, now, signals));
    const usable = states.find((state) => state.usable === true);
    if (usable) {
      result[entry.id] = usable;
      continue;
    }
    if (states.some((state) => state.usable === null)) {
      result[entry.id] = { status: { state: "unknown" }, usable: null };
      continue;
    }
    const priority = ["quota_exhausted", "rate_limited", "unavailable", "disabled"];
    result[entry.id] = priority
      .map((name) => states.find((state) => state.status.state === name))
      .find(Boolean) ?? { status: { state: "unknown" }, usable: null };
  }
  for (const entry of models) {
    if (entry.owned_by !== "combo" || !entry.members?.length) continue;
    const members = entry.members.map((id) => result[id]);
    if (members.some((member) => member?.usable === true)) {
      result[entry.id] = { status: { state: "ok" }, usable: true };
    } else if (members.some((member) => !member || member.usable === null)) {
      result[entry.id] = { status: { state: "unknown" }, usable: null };
    } else {
      const priority = ["quota_exhausted", "rate_limited", "unavailable", "disabled"];
      result[entry.id] = priority
        .map((name) => members.find((member) => member.status.state === name))
        .find(Boolean) ?? { status: { state: "unknown" }, usable: null };
    }
  }
  return result;
}
