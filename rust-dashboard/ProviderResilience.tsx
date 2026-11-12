import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  clearRustProviderQuota,
  configureRustProviderHealth,
  configureRustProviderQuota,
  listRustProviderHealth,
  listRustProviderQuotas,
  listRustProviders,
  readRustRuntimeSettings,
  refreshRustProviderQuota,
  resetRustProviderHealth,
  saveRustRuntimeSettings,
  type RustProvider,
  type RustProviderHealth,
  type RustProviderQuota,
  type RustProviderQuotaWindow,
  type RustRuntimeSettings,
} from "./api/browserClient";

const fieldClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

type HealthDraft = {
  failureThreshold: string;
  degradationThreshold: string;
  resetTimeoutSeconds: string;
};

type QuotaDraft = {
  sessionRemaining: string;
  sessionReset: string;
  weeklyRemaining: string;
  weeklyReset: string;
  limitReached: boolean;
  ttlSeconds: string;
};

type RuntimeSettingsDraft = {
  quotaPreflightEnabled: boolean;
  quotaPreflightThresholdPercent: string;
};

function runtimeSettingsDraft(settings?: RustRuntimeSettings): RuntimeSettingsDraft {
  return {
    quotaPreflightEnabled: settings?.quota_preflight_enabled ?? false,
    quotaPreflightThresholdPercent: String(settings?.quota_preflight_threshold_percent ?? 2),
  };
}

function healthDraft(health?: RustProviderHealth): HealthDraft {
  return {
    failureThreshold: String(health?.failure_threshold ?? 5),
    degradationThreshold: String(health?.degradation_threshold ?? 2),
    resetTimeoutSeconds: String(
      Math.max(1, Math.round((health?.reset_timeout_ms ?? 30_000) / 1000))
    ),
  };
}

function dateTimeInput(unixMs?: number) {
  if (!unixMs) return "";
  const date = new Date(unixMs);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function quotaDraft(quota?: RustProviderQuota): QuotaDraft {
  return {
    sessionRemaining: quota?.session ? String(quota.session.remaining_percent) : "",
    sessionReset: dateTimeInput(quota?.session?.reset_at_unix_ms),
    weeklyRemaining: quota?.weekly ? String(quota.weekly.remaining_percent) : "",
    weeklyReset: dateTimeInput(quota?.weekly?.reset_at_unix_ms),
    limitReached: quota?.limit_reached ?? false,
    ttlSeconds: quota
      ? String(
          Math.max(1, Math.round((quota.expires_at_unix_ms - quota.observed_at_unix_ms) / 1000))
        )
      : "300",
  };
}

function formatDate(unixMs?: number) {
  return unixMs ? new Date(unixMs).toLocaleString() : "Not reported";
}

function formatWindow(window?: RustProviderQuotaWindow) {
  if (!window) return "Not reported";
  const reset = window.reset_at_unix_ms ? ` · resets ${formatDate(window.reset_at_unix_ms)}` : "";
  return `${window.remaining_percent.toFixed(1)}% remaining${reset}`;
}

function asPositiveInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return number;
}

function optionalWindow(remaining: string, reset: string): RustProviderQuotaWindow | undefined {
  if (!remaining.trim()) return undefined;
  const percentage = Number(remaining);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("Quota remaining percentage must be between 0 and 100.");
  }
  if (!reset) return { remaining_percent: percentage };
  const resetAt = new Date(reset).getTime();
  if (!Number.isFinite(resetAt)) throw new Error("Quota reset time is invalid.");
  return { remaining_percent: percentage, reset_at_unix_ms: resetAt };
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export default function ProviderResilience() {
  const [providers, setProviders] = useState<RustProvider[]>([]);
  const [health, setHealth] = useState<RustProviderHealth[]>([]);
  const [quotas, setQuotas] = useState<RustProviderQuota[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [healthForm, setHealthForm] = useState<HealthDraft>(() => healthDraft());
  const [quotaForm, setQuotaForm] = useState<QuotaDraft>(() => quotaDraft());
  const [runtimeSettingsForm, setRuntimeSettingsForm] = useState<RuntimeSettingsDraft>(() =>
    runtimeSettingsDraft()
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(
    () =>
      Promise.all([
        listRustProviders(),
        listRustProviderHealth(),
        listRustProviderQuotas(),
        readRustRuntimeSettings(),
      ]),
    []
  );

  useEffect(() => {
    let active = true;
    void load()
      .then(([nextProviders, nextHealth, nextQuotas, nextRuntimeSettings]) => {
        if (!active) return;
        const nextSelected = nextProviders[0]?.id || "";
        setProviders(nextProviders);
        setHealth(nextHealth);
        setQuotas(nextQuotas);
        setSelectedId(nextSelected);
        setHealthForm(healthDraft(nextHealth.find((item) => item.provider_id === nextSelected)));
        setQuotaForm(quotaDraft(nextQuotas.find((item) => item.provider_id === nextSelected)));
        setRuntimeSettingsForm(runtimeSettingsDraft(nextRuntimeSettings));
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause, "Could not load provider resilience."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const selectedHealth = useMemo(
    () => health.find((item) => item.provider_id === selectedId),
    [health, selectedId]
  );
  const selectedQuota = useMemo(
    () => quotas.find((item) => item.provider_id === selectedId),
    [quotas, selectedId]
  );

  async function perform(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await action();
      const [nextProviders, nextHealth, nextQuotas, nextRuntimeSettings] = await load();
      setProviders(nextProviders);
      setHealth(nextHealth);
      setQuotas(nextQuotas);
      setHealthForm(healthDraft(nextHealth.find((item) => item.provider_id === selectedId)));
      setQuotaForm(quotaDraft(nextQuotas.find((item) => item.provider_id === selectedId)));
      setRuntimeSettingsForm(runtimeSettingsDraft(nextRuntimeSettings));
      setNotice(message);
    } catch (cause) {
      setError(errorMessage(cause, "Provider resilience update failed."));
    } finally {
      setBusy(false);
    }
  }

  function saveHealth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      await configureRustProviderHealth(selectedId, {
        failure_threshold: asPositiveInteger(healthForm.failureThreshold, "Failure threshold"),
        degradation_threshold: asPositiveInteger(
          healthForm.degradationThreshold,
          "Degradation threshold"
        ),
        reset_timeout_ms: asPositiveInteger(healthForm.resetTimeoutSeconds, "Reset timeout") * 1000,
      });
      return `Circuit-breaker policy for ${selectedId} saved.`;
    });
  }

  function saveQuota(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      const session = optionalWindow(quotaForm.sessionRemaining, quotaForm.sessionReset);
      const weekly = optionalWindow(quotaForm.weeklyRemaining, quotaForm.weeklyReset);
      if (!session && !weekly) throw new Error("Enter at least one quota window.");
      await configureRustProviderQuota(selectedId, {
        ...(session ? { session } : {}),
        ...(weekly ? { weekly } : {}),
        limit_reached: quotaForm.limitReached,
        ttl_seconds: asPositiveInteger(quotaForm.ttlSeconds, "Quota TTL"),
      });
      return `Quota override for ${selectedId} saved.`;
    });
  }

  function saveRuntimeSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      const threshold = Number(runtimeSettingsForm.quotaPreflightThresholdPercent);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("Quota cutoff must be between 0 and 100 percent.");
      }
      await saveRustRuntimeSettings({
        quota_preflight_enabled: runtimeSettingsForm.quotaPreflightEnabled,
        quota_preflight_threshold_percent: threshold,
      });
      return "Global Rust routing policy saved.";
    });
  }

  const currentProvider = providers.find((provider) => provider.id === selectedId);

  function selectProvider(providerId: string) {
    setSelectedId(providerId);
    setHealthForm(healthDraft(health.find((item) => item.provider_id === providerId)));
    setQuotaForm(quotaDraft(quotas.find((item) => item.provider_id === providerId)));
  }

  if (loading) return <div className="p-6">Loading provider resilience…</div>;

  return (
    <section className="mx-auto max-w-7xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Provider resilience and quotas</h1>
        <p className="mt-1 text-text-muted">
          Operate Rust-owned circuit breakers, connection cooldowns and provider quota snapshots.
          Changes are durable and affect routing on every proxy replica.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      <form className="space-y-4 rounded border border-border p-4" onSubmit={saveRuntimeSettings}>
        <div>
          <h2 className="text-lg font-semibold">Global quota preflight</h2>
          <p className="text-sm text-text-muted">
            Skip connections whose fresh session or weekly quota is at or below the cutoff before
            reserving usage or calling the provider. Unknown and expired telemetry remains eligible.
          </p>
        </div>
        <label className="block">
          <input
            type="checkbox"
            checked={runtimeSettingsForm.quotaPreflightEnabled}
            onChange={(event) =>
              setRuntimeSettingsForm({
                ...runtimeSettingsForm,
                quotaPreflightEnabled: event.target.checked,
              })
            }
          />{" "}
          Enable quota preflight
        </label>
        <label className="block max-w-xs">
          Minimum remaining quota (%)
          <input
            className={fieldClass}
            type="number"
            min="0"
            max="100"
            step="0.1"
            required
            value={runtimeSettingsForm.quotaPreflightThresholdPercent}
            onChange={(event) =>
              setRuntimeSettingsForm({
                ...runtimeSettingsForm,
                quotaPreflightThresholdPercent: event.target.value,
              })
            }
          />
        </label>
        <button type="submit" disabled={busy}>
          Save global policy
        </button>
      </form>

      {providers.length === 0 ? (
        <p>Add a provider before configuring resilience.</p>
      ) : (
        <>
          <label className="block max-w-xl">
            Provider connection
            <select
              className={fieldClass}
              value={selectedId}
              disabled={busy}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label} ({provider.id})
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded border border-border p-4">
              <h2 className="font-semibold">Connection</h2>
              <p>{currentProvider?.enabled ? "Enabled" : "Disabled"}</p>
              <p className="text-sm text-text-muted">{currentProvider?.provider}</p>
            </article>
            <article className="rounded border border-border p-4">
              <h2 className="font-semibold">Circuit</h2>
              <p>{selectedHealth?.state ?? "closed"}</p>
              <p className="text-sm text-text-muted">
                {selectedHealth?.failure_count ?? 0} failures ·{" "}
                {selectedHealth?.retry_after_ms ?? 0} ms retry
              </p>
            </article>
            <article className="rounded border border-border p-4">
              <h2 className="font-semibold">Account state</h2>
              <p>{selectedHealth?.terminal_status ?? "available"}</p>
              <p className="text-sm text-text-muted">
                cooldown {selectedHealth?.connection_retry_after_ms ?? 0} ms
              </p>
            </article>
            <article className="rounded border border-border p-4">
              <h2 className="font-semibold">Quota</h2>
              <p>
                {selectedQuota?.limit_reached
                  ? "Exhausted"
                  : selectedQuota
                    ? "Available"
                    : "Unknown"}
              </p>
              <p className="text-sm text-text-muted">
                {selectedQuota
                  ? `expires ${formatDate(selectedQuota.expires_at_unix_ms)}`
                  : "No snapshot"}
              </p>
            </article>
          </div>

          {(selectedHealth?.model_lockouts.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded border border-border p-4">
              <h2 className="mb-3 font-semibold">Model lockouts</h2>
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="p-2">Model</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Retry</th>
                    <th className="p-2">Until</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedHealth?.model_lockouts.map((lockout) => (
                    <tr key={lockout.model}>
                      <td className="border-t border-border p-2">{lockout.model}</td>
                      <td className="border-t border-border p-2">{lockout.status}</td>
                      <td className="border-t border-border p-2">{lockout.retry_after_ms} ms</td>
                      <td className="border-t border-border p-2">
                        {formatDate(lockout.until_unix_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <form className="space-y-4 rounded border border-border p-4" onSubmit={saveHealth}>
              <h2 className="text-lg font-semibold">Circuit-breaker policy</h2>
              <label className="block">
                Failures before opening
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  required
                  value={healthForm.failureThreshold}
                  onChange={(event) =>
                    setHealthForm({ ...healthForm, failureThreshold: event.target.value })
                  }
                />
              </label>
              <label className="block">
                Failures before degradation
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  required
                  value={healthForm.degradationThreshold}
                  onChange={(event) =>
                    setHealthForm({ ...healthForm, degradationThreshold: event.target.value })
                  }
                />
              </label>
              <label className="block">
                Reset timeout (seconds)
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  required
                  value={healthForm.resetTimeoutSeconds}
                  onChange={(event) =>
                    setHealthForm({ ...healthForm, resetTimeoutSeconds: event.target.value })
                  }
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={busy}>
                  Save circuit policy
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await resetRustProviderHealth(selectedId);
                      return `Health state for ${selectedId} reset.`;
                    })
                  }
                >
                  Reset runtime health
                </button>
              </div>
            </form>

            <form className="space-y-4 rounded border border-border p-4" onSubmit={saveQuota}>
              <div>
                <h2 className="text-lg font-semibold">Provider quota</h2>
                <p className="text-sm text-text-muted">
                  Session: {formatWindow(selectedQuota?.session)}
                </p>
                <p className="text-sm text-text-muted">
                  Weekly: {formatWindow(selectedQuota?.weekly)}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  Session remaining (%)
                  <input
                    className={fieldClass}
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={quotaForm.sessionRemaining}
                    onChange={(event) =>
                      setQuotaForm({ ...quotaForm, sessionRemaining: event.target.value })
                    }
                  />
                </label>
                <label>
                  Session reset
                  <input
                    className={fieldClass}
                    type="datetime-local"
                    value={quotaForm.sessionReset}
                    onChange={(event) =>
                      setQuotaForm({ ...quotaForm, sessionReset: event.target.value })
                    }
                  />
                </label>
                <label>
                  Weekly remaining (%)
                  <input
                    className={fieldClass}
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={quotaForm.weeklyRemaining}
                    onChange={(event) =>
                      setQuotaForm({ ...quotaForm, weeklyRemaining: event.target.value })
                    }
                  />
                </label>
                <label>
                  Weekly reset
                  <input
                    className={fieldClass}
                    type="datetime-local"
                    value={quotaForm.weeklyReset}
                    onChange={(event) =>
                      setQuotaForm({ ...quotaForm, weeklyReset: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="block">
                Snapshot TTL (seconds)
                <input
                  className={fieldClass}
                  type="number"
                  min="1"
                  required
                  value={quotaForm.ttlSeconds}
                  onChange={(event) =>
                    setQuotaForm({ ...quotaForm, ttlSeconds: event.target.value })
                  }
                />
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={quotaForm.limitReached}
                  onChange={(event) =>
                    setQuotaForm({ ...quotaForm, limitReached: event.target.checked })
                  }
                />{" "}
                Force exhausted state
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={busy}>
                  Save manual snapshot
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const result = await refreshRustProviderQuota(selectedId);
                      return result.refreshed
                        ? `Quota for ${selectedId} refreshed.`
                        : `Quota refresh: ${result.category}.`;
                    })
                  }
                >
                  Refresh from provider
                </button>
                <button
                  type="button"
                  disabled={busy || !selectedQuota}
                  onClick={() =>
                    void perform(async () => {
                      await clearRustProviderQuota(selectedId);
                      return `Quota snapshot for ${selectedId} cleared.`;
                    })
                  }
                >
                  Clear snapshot
                </button>
              </div>
            </form>
          </div>

          {(selectedQuota?.models?.length ?? 0) > 0 && (
            <div className="overflow-x-auto rounded border border-border p-4">
              <h2 className="mb-3 font-semibold">Model quotas</h2>
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="p-2">Model</th>
                    <th className="p-2">Session</th>
                    <th className="p-2">Weekly</th>
                    <th className="p-2">State</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedQuota?.models?.map((model) => (
                    <tr key={model.model_id}>
                      <td className="border-t border-border p-2">{model.model_id}</td>
                      <td className="border-t border-border p-2">{formatWindow(model.session)}</td>
                      <td className="border-t border-border p-2">{formatWindow(model.weekly)}</td>
                      <td className="border-t border-border p-2">
                        {model.limit_reached ? "Exhausted" : "Available"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
