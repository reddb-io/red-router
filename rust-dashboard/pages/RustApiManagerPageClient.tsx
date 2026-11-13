"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteRustClientKey,
  deleteRustTokenLimit,
  issueRustClientKey,
  listRustClientKeys,
  listRustTokenLimits,
  readRustUsageSummary,
  replaceRustClientKey,
  saveRustTokenLimit,
  type RustClientKey,
  type RustClientKeyInput,
  type RustTokenLimit,
  type RustTokenLimitInterval,
  type RustUsageSummary,
} from "../api/browserClient";

type Draft = {
  label: string;
  enabled: boolean;
  modelIdFormat: "prefixed" | "flat";
  expiresAt: string;
  scheduleEnabled: boolean;
  scheduleFrom: string;
  scheduleUntil: string;
  scheduleDays: string;
  scheduleTz: string;
  scopes: string;
  allowedEndpoints: string;
  allowedModels: string;
  blockedModels: string;
  allowedProviderIds: string;
  maxConcurrent: string;
  maxRpm: string;
  maxRpd: string;
  maxTpm: string;
  maxTokensPerDay: string;
  maxMonthlySpend: string;
  reservationTokens: string;
  reservationSpend: string;
};

type TokenLimitDraft = {
  id?: string;
  model: string;
  tokenLimit: string;
  resetInterval: RustTokenLimitInterval;
  resetTime: string;
};

const EMPTY_TOKEN_LIMIT_DRAFT: TokenLimitDraft = {
  model: "",
  tokenLimit: "",
  resetInterval: "daily",
  resetTime: "00:00",
};

const EMPTY_DRAFT: Draft = {
  label: "",
  enabled: true,
  modelIdFormat: "prefixed",
  expiresAt: "",
  scheduleEnabled: false,
  scheduleFrom: "08:00",
  scheduleUntil: "18:00",
  scheduleDays: "1,2,3,4,5",
  scheduleTz: "UTC",
  scopes: "inference:chat",
  allowedEndpoints: "chat",
  allowedModels: "",
  blockedModels: "",
  allowedProviderIds: "",
  maxConcurrent: "",
  maxRpm: "",
  maxRpd: "",
  maxTpm: "",
  maxTokensPerDay: "",
  maxMonthlySpend: "",
  reservationTokens: "",
  reservationSpend: "",
};

const inputClass =
  "w-full rounded-lg border border-black/10 dark:border-white/10 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-text-muted";

function list(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Limits must be positive numbers");
  return parsed;
}

function optionalInteger(value: string): number | null {
  const parsed = optionalNumber(value);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(parsed)) throw new Error("Limits must be safe integers");
  return parsed;
}

function expiresAtUnix(value: string): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("Invalid expiration time");
  return Math.floor(millis / 1_000);
}

function draftInput(draft: Draft, tenantId?: string): RustClientKeyInput {
  const label = draft.label.trim();
  if (!label) throw new Error("A key label is required");
  const scheduleDays = list(draft.scheduleDays).map(Number);
  if (
    draft.scheduleEnabled &&
    scheduleDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error("Schedule days must use 0-6, where Sunday is 0");
  }
  const scheduleTz = draft.scheduleTz.trim();
  if (draft.scheduleEnabled && !scheduleTz) {
    throw new Error("An IANA timezone is required for the access schedule");
  }
  return {
    label,
    ...(tenantId ? { tenant_id: tenantId } : {}),
    model_id_format: draft.modelIdFormat,
    enabled: draft.enabled,
    expires_at_unix: expiresAtUnix(draft.expiresAt),
    access_schedule: draft.scheduleEnabled
      ? {
          enabled: true,
          from: draft.scheduleFrom,
          until: draft.scheduleUntil,
          days: scheduleDays,
          tz: scheduleTz,
        }
      : null,
    scopes: list(draft.scopes),
    allowed_endpoints: list(draft.allowedEndpoints),
    allowed_models: list(draft.allowedModels),
    blocked_models: list(draft.blockedModels),
    allowed_provider_ids: list(draft.allowedProviderIds),
    max_concurrent_requests: optionalInteger(draft.maxConcurrent),
    max_requests_per_minute: optionalInteger(draft.maxRpm),
    max_requests_per_day: optionalInteger(draft.maxRpd),
    max_tokens_per_minute: optionalInteger(draft.maxTpm),
    max_tokens_per_day: optionalInteger(draft.maxTokensPerDay),
    max_spend_per_month_usd: optionalNumber(draft.maxMonthlySpend),
    reservation_tokens: optionalInteger(draft.reservationTokens),
    reservation_spend_usd: optionalNumber(draft.reservationSpend),
  };
}

function localExpiry(value: number | null): string {
  if (!value) return "";
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  try {
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  } catch {
    return "";
  }
}

function keyDraft(key: RustClientKey): Draft {
  const number = (value: number | null) => (value === null ? "" : String(value));
  return {
    label: key.label,
    enabled: key.enabled,
    modelIdFormat: key.model_id_format,
    expiresAt: localExpiry(key.expires_at_unix),
    scheduleEnabled: key.access_schedule?.enabled ?? false,
    scheduleFrom: key.access_schedule?.from ?? "08:00",
    scheduleUntil: key.access_schedule?.until ?? "18:00",
    scheduleDays: key.access_schedule?.days.join(",") ?? "1,2,3,4,5",
    scheduleTz: key.access_schedule?.tz ?? "UTC",
    scopes: key.scopes.join("\n"),
    allowedEndpoints: key.allowed_endpoints.join("\n"),
    allowedModels: key.allowed_models.join("\n"),
    blockedModels: key.blocked_models.join("\n"),
    allowedProviderIds: key.allowed_provider_ids.join("\n"),
    maxConcurrent: number(key.max_concurrent_requests),
    maxRpm: number(key.max_requests_per_minute),
    maxRpd: number(key.max_requests_per_day),
    maxTpm: number(key.max_tokens_per_minute),
    maxTokensPerDay: number(key.max_tokens_per_day),
    maxMonthlySpend: number(key.max_spend_per_month_usd),
    reservationTokens: number(key.reservation_tokens),
    reservationSpend: number(key.reservation_spend_usd),
  };
}

function usd(microusd: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    microusd / 1_000_000
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Management request failed";
}

function PolicyFields({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const set = <K extends keyof Draft>(name: K, value: Draft[K]) =>
    onChange({ ...draft, [name]: value });
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <label className={labelClass}>
        Label
        <input
          className={inputClass}
          value={draft.label}
          onChange={(e) => set("label", e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Model ID format
        <select
          className={inputClass}
          value={draft.modelIdFormat}
          onChange={(e) => set("modelIdFormat", e.target.value as Draft["modelIdFormat"])}
        >
          <option value="prefixed">Provider-prefixed</option>
          <option value="flat">Flat</option>
        </select>
      </label>
      <label className={labelClass}>
        Expiration
        <input
          className={inputClass}
          type="datetime-local"
          value={draft.expiresAt}
          onChange={(e) => set("expiresAt", e.target.value)}
        />
      </label>
      <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 md:col-span-2 xl:col-span-3">
        <label className="flex items-center gap-2 text-sm font-medium text-text">
          <input
            type="checkbox"
            checked={draft.scheduleEnabled}
            onChange={(e) => set("scheduleEnabled", e.target.checked)}
          />
          Restrict access by local schedule
        </label>
        {draft.scheduleEnabled && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={labelClass}>
              From
              <input
                className={inputClass}
                type="time"
                value={draft.scheduleFrom}
                onChange={(e) => set("scheduleFrom", e.target.value)}
              />
            </label>
            <label className={labelClass}>
              Until
              <input
                className={inputClass}
                type="time"
                value={draft.scheduleUntil}
                onChange={(e) => set("scheduleUntil", e.target.value)}
              />
            </label>
            <label className={labelClass}>
              Days (Sunday=0)
              <input
                className={inputClass}
                value={draft.scheduleDays}
                onChange={(e) => set("scheduleDays", e.target.value)}
                placeholder="1,2,3,4,5"
              />
              <span className="text-xs text-text-muted">
                An empty list blocks access on every day.
              </span>
            </label>
            <label className={labelClass}>
              IANA timezone
              <input
                className={inputClass}
                value={draft.scheduleTz}
                onChange={(e) => set("scheduleTz", e.target.value)}
                placeholder="America/Sao_Paulo"
              />
            </label>
          </div>
        )}
      </div>
      <label className={labelClass}>
        Scopes (comma or newline)
        <textarea
          className={inputClass}
          rows={3}
          value={draft.scopes}
          onChange={(e) => set("scopes", e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Endpoint grants
        <textarea
          className={inputClass}
          rows={3}
          value={draft.allowedEndpoints}
          onChange={(e) => set("allowedEndpoints", e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Provider connection grants
        <textarea
          className={inputClass}
          rows={3}
          value={draft.allowedProviderIds}
          onChange={(e) => set("allowedProviderIds", e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Allowed models
        <textarea
          className={inputClass}
          rows={3}
          value={draft.allowedModels}
          onChange={(e) => set("allowedModels", e.target.value)}
        />
      </label>
      <label className={labelClass}>
        Blocked models
        <textarea
          className={inputClass}
          rows={3}
          value={draft.blockedModels}
          onChange={(e) => set("blockedModels", e.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          Concurrent
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxConcurrent}
            onChange={(e) => set("maxConcurrent", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Requests/min
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxRpm}
            onChange={(e) => set("maxRpm", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Requests/day
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxRpd}
            onChange={(e) => set("maxRpd", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Tokens/min
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxTpm}
            onChange={(e) => set("maxTpm", e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          Tokens/day
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.maxTokensPerDay}
            onChange={(e) => set("maxTokensPerDay", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          USD/month
          <input
            className={inputClass}
            inputMode="decimal"
            value={draft.maxMonthlySpend}
            onChange={(e) => set("maxMonthlySpend", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Reserve tokens
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.reservationTokens}
            onChange={(e) => set("reservationTokens", e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Reserve USD
          <input
            className={inputClass}
            inputMode="decimal"
            value={draft.reservationSpend}
            onChange={(e) => set("reservationSpend", e.target.value)}
          />
        </label>
      </div>
      <label className="flex items-center gap-2 self-end rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        Enabled
      </label>
    </div>
  );
}

export default function RustApiManagerPageClient() {
  const [keys, setKeys] = useState<RustClientKey[]>([]);
  const [usage, setUsage] = useState<RustUsageSummary | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<RustClientKey | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenLimitKey, setTokenLimitKey] = useState<RustClientKey | null>(null);
  const [tokenLimits, setTokenLimits] = useState<RustTokenLimit[]>([]);
  const [tokenLimitDraft, setTokenLimitDraft] = useState<TokenLimitDraft>(EMPTY_TOKEN_LIMIT_DRAFT);
  const [tokenLimitsLoading, setTokenLimitsLoading] = useState(false);

  const refresh = useCallback(async () => {
    const [nextKeys, nextUsage] = await Promise.all([listRustClientKeys(), readRustUsageSummary()]);
    setKeys(nextKeys);
    setUsage(nextUsage);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await refresh();
    })()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [refresh]);

  const totals = useMemo(() => {
    if (!usage) return [];
    return [
      ["Requests", usage.request_count.toLocaleString()],
      ["Input tokens", usage.tokens_input.toLocaleString()],
      ["Output tokens", usage.tokens_output.toLocaleString()],
      ["Recorded spend", usd(usage.amount_microusd)],
      ["Pending", usage.pending_request_count.toLocaleString()],
    ];
  }, [usage]);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const issued = await issueRustClientKey(draftInput(draft));
      setSecret(issued.key);
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await replaceRustClientKey(editing.id, draftInput(draft, editing.tenant_id));
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (key: RustClientKey) => {
    if (!window.confirm(`Revoke ${key.label}? Existing clients will stop immediately.`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteRustClientKey(key.id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const openTokenLimits = async (key: RustClientKey) => {
    setTokenLimitKey(key);
    setTokenLimitDraft(EMPTY_TOKEN_LIMIT_DRAFT);
    setTokenLimitsLoading(true);
    setError(null);
    try {
      setTokenLimits(await listRustTokenLimits(key.id));
    } catch (cause) {
      setError(errorMessage(cause));
      setTokenLimits([]);
    } finally {
      setTokenLimitsLoading(false);
    }
  };

  const saveTokenLimit = async () => {
    if (!tokenLimitKey) return;
    const model = tokenLimitDraft.model.trim();
    const tokenLimit = Number(tokenLimitDraft.tokenLimit);
    if (!model || model.length > 256) {
      setError("A model ID between 1 and 256 characters is required");
      return;
    }
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) {
      setError("The model token limit must be a positive safe integer");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveRustTokenLimit({
        ...(tokenLimitDraft.id ? { id: tokenLimitDraft.id } : {}),
        apiKeyId: tokenLimitKey.id,
        scopeType: "model",
        scopeValue: model,
        tokenLimit,
        resetInterval: tokenLimitDraft.resetInterval,
        resetTime: tokenLimitDraft.resetTime,
        enabled: true,
      });
      setTokenLimits(await listRustTokenLimits(tokenLimitKey.id));
      setTokenLimitDraft(EMPTY_TOKEN_LIMIT_DRAFT);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeTokenLimit = async (limit: RustTokenLimit) => {
    if (!tokenLimitKey || !window.confirm(`Delete the ${limit.scopeValue} token limit?`)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteRustTokenLimit(limit.id);
      setTokenLimits(await listRustTokenLimits(tokenLimitKey.id));
      if (tokenLimitDraft.id === limit.id) setTokenLimitDraft(EMPTY_TOKEN_LIMIT_DRAFT);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-text-muted">Loading API keys…</div>;
  }

  return (
    <main className="space-y-5 p-4 md:p-6" id="main-content">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-text">API keys</h1>
            <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
              API keys
            </span>
          </div>
          <p className="max-w-3xl text-sm text-text-muted">
            Secrets are returned once and stored only as hashes. Policies, tenant ownership, quotas
            and accounting are committed by red-routerd.
          </p>
        </div>
        <button
          className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-surface"
          onClick={() => void refresh()}
          disabled={saving}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}
      {secret && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            Copy this key now. It cannot be revealed again.
          </p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/10 px-3 py-2 text-sm">
              {secret}
            </code>
            <button
              className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white"
              onClick={() => void navigator.clipboard.writeText(secret)}
            >
              Copy
            </button>
            <button className="rounded-lg px-3 py-2 text-sm" onClick={() => setSecret(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {totals.length > 0 && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {totals.map(([name, value]) => (
            <div
              key={name}
              className="rounded-xl border border-black/10 dark:border-white/10 bg-surface p-3"
            >
              <div className="text-xs text-text-muted">{name}</div>
              <div className="mt-1 text-lg font-semibold text-text">{value}</div>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 p-4">
        <h2 className="mb-1 text-base font-semibold text-text">
          {editing ? `Edit ${editing.label}` : "Issue a client key"}
        </h2>
        <p className="mb-4 text-xs text-text-muted">
          Empty grant lists mean unrestricted access within the key&apos;s tenant. Token or spend
          quotas require conservative reservation values.
        </p>
        <PolicyFields draft={draft} onChange={setDraft} />
        <div className="mt-4 flex justify-end gap-2">
          {editing && (
            <button
              className="rounded-lg px-4 py-2 text-sm hover:bg-surface"
              onClick={() => {
                setEditing(null);
                setDraft(EMPTY_DRAFT);
              }}
            >
              Cancel
            </button>
          )}
          <button
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saving}
            onClick={() => void (editing ? save() : create())}
          >
            {saving ? "Saving…" : editing ? "Save policy" : "Issue key"}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-surface/50">
        <div className="border-b border-black/10 dark:border-white/10 px-4 py-3 text-sm font-semibold text-text">
          {keys.length} durable key{keys.length === 1 ? "" : "s"}
        </div>
        {keys.length === 0 ? (
          <div className="p-6 text-sm text-text-muted">No client keys yet.</div>
        ) : (
          keys.map((key) => (
            <article
              key={key.id}
              className="flex flex-col gap-3 border-b border-black/5 dark:border-white/5 p-4 last:border-0 lg:flex-row lg:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-text">{key.label}</strong>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${key.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-zinc-500/10 text-text-muted"}`}
                  >
                    {key.enabled ? "enabled" : "disabled"}
                  </span>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                    {key.tenant_id}
                  </span>
                </div>
                <code className="mt-1 block truncate text-xs text-text-muted">{key.id}</code>
                <p className="mt-2 text-xs text-text-muted">
                  {key.allowed_endpoints.length
                    ? key.allowed_endpoints.join(", ")
                    : "all endpoints"}{" "}
                  ·{" "}
                  {key.allowed_models.length
                    ? `${key.allowed_models.length} model grants`
                    : "all models"}{" "}
                  ·{" "}
                  {key.access_schedule?.enabled
                    ? `${key.access_schedule.from}-${key.access_schedule.until} ${key.access_schedule.tz}`
                    : "always available"}{" "}
                  · created by {key.created_by}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-surface"
                  onClick={() => void openTokenLimits(key)}
                >
                  Model quotas
                </button>
                <button
                  className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-surface"
                  onClick={() => {
                    setEditing(key);
                    setDraft(keyDraft(key));
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  Edit
                </button>
                <button
                  className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-600 hover:bg-red-500/10"
                  disabled={saving}
                  onClick={() => void revoke(key)}
                >
                  Revoke
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      {tokenLimitKey && (
        <section className="rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text">
                Model token quotas · {tokenLimitKey.label}
              </h2>
              <p className="mt-1 max-w-3xl text-xs text-text-muted">
                The key must stay disabled while a model quota is changed. A global token or spend
                quota and a conservative token reservation are required before the server accepts a
                model limit.
              </p>
            </div>
            <button
              className="rounded-lg px-3 py-2 text-sm hover:bg-surface"
              onClick={() => {
                setTokenLimitKey(null);
                setTokenLimits([]);
                setTokenLimitDraft(EMPTY_TOKEN_LIMIT_DRAFT);
              }}
            >
              Close
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className={labelClass}>
              Exact model ID
              <input
                className={inputClass}
                value={tokenLimitDraft.model}
                disabled={Boolean(tokenLimitDraft.id)}
                placeholder="openai/gpt-5"
                onChange={(event) =>
                  setTokenLimitDraft({ ...tokenLimitDraft, model: event.target.value })
                }
              />
            </label>
            <label className={labelClass}>
              Token limit
              <input
                className={inputClass}
                inputMode="numeric"
                value={tokenLimitDraft.tokenLimit}
                onChange={(event) =>
                  setTokenLimitDraft({ ...tokenLimitDraft, tokenLimit: event.target.value })
                }
              />
            </label>
            <label className={labelClass}>
              Reset interval
              <select
                className={inputClass}
                value={tokenLimitDraft.resetInterval}
                disabled={Boolean(tokenLimitDraft.id)}
                onChange={(event) =>
                  setTokenLimitDraft({
                    ...tokenLimitDraft,
                    resetInterval: event.target.value as RustTokenLimitInterval,
                  })
                }
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (Monday)</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className={labelClass}>
              Reset time (UTC)
              <input
                className={inputClass}
                type="time"
                value={tokenLimitDraft.resetTime}
                onChange={(event) =>
                  setTokenLimitDraft({ ...tokenLimitDraft, resetTime: event.target.value })
                }
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {tokenLimitDraft.id && (
              <button
                className="rounded-lg px-3 py-2 text-sm hover:bg-surface"
                onClick={() => setTokenLimitDraft(EMPTY_TOKEN_LIMIT_DRAFT)}
              >
                Cancel edit
              </button>
            )}
            <button
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={saving || tokenLimitKey.enabled}
              onClick={() => void saveTokenLimit()}
            >
              {tokenLimitDraft.id ? "Update model quota" : "Add model quota"}
            </button>
          </div>
          {tokenLimitKey.enabled && (
            <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Disable this key before changing model quotas.
            </p>
          )}

          <div className="mt-4 overflow-x-auto">
            {tokenLimitsLoading ? (
              <p className="text-sm text-text-muted">Loading model quotas…</p>
            ) : tokenLimits.length === 0 ? (
              <p className="text-sm text-text-muted">No model token quotas configured.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="py-2 pr-3">Model</th>
                    <th className="py-2 pr-3">Window</th>
                    <th className="py-2 pr-3">Used / limit</th>
                    <th className="py-2 pr-3">Next reset</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenLimits.map((limit) => (
                    <tr key={limit.id} className="border-t border-black/5 dark:border-white/5">
                      <td className="py-2 pr-3 font-mono text-xs">{limit.scopeValue}</td>
                      <td className="py-2 pr-3">
                        {limit.resetInterval} · {limit.resetTime} UTC
                      </td>
                      <td className="py-2 pr-3">
                        {limit.tokensUsed.toLocaleString()} / {limit.tokenLimit.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3">{new Date(limit.nextResetAt).toLocaleString()}</td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="rounded border border-black/10 dark:border-white/10 px-2 py-1 text-xs"
                            disabled={tokenLimitKey.enabled}
                            onClick={() =>
                              setTokenLimitDraft({
                                id: limit.id,
                                model: limit.scopeValue,
                                tokenLimit: String(limit.tokenLimit),
                                resetInterval: limit.resetInterval,
                                resetTime: limit.resetTime,
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-600"
                            disabled={saving || tokenLimitKey.enabled}
                            onClick={() => void removeTokenLimit(limit)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
