"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import RustProviderOAuthModal from "./RustProviderOAuthModal";
import RustProviderSessionImportModal from "./RustProviderSessionImportModal";
import {
  clearRustProviderQuota,
  configureRustProviderQuota,
  configureRustProviderHealth,
  disableRustProvider,
  deleteRustProvider,
  listRustProviderHealth,
  listRustProviderQuotas,
  listRustProviders,
  readRustCatalogProvider,
  readRustModelCatalog,
  refreshRustModelCatalog,
  refreshRustProviderOAuth,
  refreshRustProviderQuota,
  resetRustProviderHealth,
  replaceRustProvider,
  testRustProvider,
  type RustCatalogProvider,
  type RustModelCatalogIndex,
  type RustProvider,
  type RustProviderDiagnostic,
  type RustProviderAuthScheme,
  type RustProviderHealth,
  type RustProviderInput,
  type RustProviderOAuthKind,
  type RustProviderQuota,
  type RustProviderQuotaRefreshCategory,
  type RustRateLimitScope,
} from "@/lib/rustControlPlane/browserClient";

type Draft = {
  id: string;
  provider: string;
  upstreamUrl: string;
  apiKey: string;
  enabled: boolean;
  rateLimitScope: RustRateLimitScope;
  authScheme: RustProviderAuthScheme;
  label: string;
  accountEmail: string;
  expiresAt: string;
  credentialType: "static" | "oauth";
  oauthProvider: RustProviderOAuthKind;
  refreshToken: string;
};

type HealthDraft = {
  failureThreshold: string;
  degradationThreshold: string;
  resetTimeoutMs: string;
};

type QuotaDraft = {
  sessionRemainingPercent: string;
  sessionResetAt: string;
  weeklyRemainingPercent: string;
  weeklyResetAt: string;
  limitReached: boolean;
  ttlSeconds: string;
};

const EMPTY_QUOTA_DRAFT: QuotaDraft = {
  sessionRemainingPercent: "",
  sessionResetAt: "",
  weeklyRemainingPercent: "",
  weeklyResetAt: "",
  limitReached: false,
  ttlSeconds: "300",
};

const EMPTY_DRAFT: Draft = {
  id: "",
  provider: "openai-compatible",
  upstreamUrl: "",
  apiKey: "",
  enabled: true,
  rateLimitScope: "auto",
  authScheme: "auto",
  label: "",
  accountEmail: "",
  expiresAt: "",
  credentialType: "static",
  oauthProvider: "codex",
  refreshToken: "",
};

const inputClass =
  "w-full rounded-lg border border-black/10 dark:border-white/10 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-text-muted";

function providerDraft(provider: RustProvider): Draft {
  return {
    id: provider.id,
    provider: provider.provider,
    upstreamUrl: provider.upstream_url,
    apiKey: "",
    enabled: provider.enabled,
    rateLimitScope: provider.rate_limit_scope,
    authScheme: provider.auth_scheme,
    label: provider.label,
    accountEmail: provider.account_email ?? "",
    expiresAt: localDateTime(provider.expires_at_unix),
    credentialType: provider.credential_type,
    oauthProvider: provider.oauth_provider ?? "codex",
    refreshToken: "",
  };
}

function localDateTime(unixSeconds?: number): string {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1_000);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function providerInput(draft: Draft, editing: boolean): RustProviderInput {
  const id = draft.id.trim();
  const provider = draft.provider.trim();
  const upstreamUrl = draft.upstreamUrl.trim();
  const apiKey = draft.apiKey;
  const label = draft.label.trim() || id;
  const accountEmail = draft.accountEmail.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Connection ID must contain only letters, numbers, dashes or underscores");
  }
  if (!provider || provider.length > 64 || !/^[a-z0-9-]+$/.test(provider)) {
    throw new Error("Provider type must use lowercase letters, numbers or dashes");
  }
  if (!label || label.length > 128) {
    throw new Error("Connection label must contain between 1 and 128 characters");
  }
  if (accountEmail.length > 320) throw new Error("Provider account email is too long");
  if ((!editing && !apiKey) || new TextEncoder().encode(apiKey).length > 8192) {
    throw new Error(
      editing
        ? "A replacement provider credential cannot exceed 8192 bytes"
        : "A provider credential between 1 and 8192 bytes is required"
    );
  }
  if (upstreamUrl.length > 2048) throw new Error("Upstream URL is too long");
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    throw new Error("A valid upstream URL is required");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Upstream URL must use HTTP or HTTPS");
  }
  const expiresAt = draft.expiresAt ? new Date(draft.expiresAt) : null;
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
    throw new Error("Credential expiry is invalid");
  }
  if (draft.credentialType === "oauth") {
    if (provider !== draft.oauthProvider) {
      throw new Error("OAuth account type must match the provider type");
    }
    if (draft.authScheme !== "bearer") {
      throw new Error("OAuth accounts must use Authorization: Bearer");
    }
    if (
      (!editing && !draft.refreshToken) ||
      new TextEncoder().encode(draft.refreshToken).length > 8192
    ) {
      throw new Error(
        editing
          ? "A replacement OAuth refresh token cannot exceed 8192 bytes"
          : "An OAuth refresh token between 1 and 8192 bytes is required"
      );
    }
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new Error("OAuth credential expiry must be in the future");
    }
  }
  return {
    provider,
    upstream_url: upstreamUrl,
    api_key: apiKey,
    enabled: draft.enabled,
    rate_limit_scope: draft.rateLimitScope,
    auth_scheme: draft.authScheme,
    label,
    ...(accountEmail ? { account_email: accountEmail } : {}),
    ...(expiresAt ? { expires_at_unix: Math.floor(expiresAt.getTime() / 1_000) } : {}),
    credential_type: draft.credentialType,
    ...(draft.credentialType === "oauth"
      ? { oauth_provider: draft.oauthProvider, refresh_token: draft.refreshToken }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Rust control-plane request failed";
}

function catalogDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function quotaDate(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
}

function quotaPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}% remaining`;
}

function localDateTimeMs(unixMs?: number): string {
  if (!unixMs) return "";
  const date = new Date(unixMs);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function quotaDraftFromQuota(quota?: RustProviderQuota): QuotaDraft {
  if (!quota) return EMPTY_QUOTA_DRAFT;
  return {
    sessionRemainingPercent:
      quota.session?.remaining_percent === undefined ? "" : String(quota.session.remaining_percent),
    sessionResetAt: localDateTimeMs(quota.session?.reset_at_unix_ms),
    weeklyRemainingPercent:
      quota.weekly?.remaining_percent === undefined ? "" : String(quota.weekly.remaining_percent),
    weeklyResetAt: localDateTimeMs(quota.weekly?.reset_at_unix_ms),
    limitReached: quota.limit_reached,
    ttlSeconds: String(
      Math.max(1, Math.min(86_400, Math.round((quota.expires_at_unix_ms - Date.now()) / 1_000)))
    ),
  };
}

function supportsQuotaRefresh(provider: RustProvider): boolean {
  return (
    provider.credential_type === "oauth" &&
    (provider.oauth_provider === "codex" ||
      provider.oauth_provider === "claude" ||
      provider.oauth_provider === "agy")
  );
}

export default function RustProvidersPageClient() {
  const [providers, setProviders] = useState<RustProvider[]>([]);
  const [providerQuotas, setProviderQuotas] = useState<Record<string, RustProviderQuota>>({});
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, QuotaDraft>>({});
  const [providerHealth, setProviderHealth] = useState<Record<string, RustProviderHealth>>({});
  const [healthDrafts, setHealthDrafts] = useState<Record<string, HealthDraft>>({});
  const [catalog, setCatalog] = useState<RustModelCatalogIndex | null>(null);
  const [catalogProvider, setCatalogProvider] = useState<RustCatalogProvider | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [quotaRefreshCategories, setQuotaRefreshCategories] = useState<
    Record<string, RustProviderQuotaRefreshCategory>
  >({});
  const [diagnosticModels, setDiagnosticModels] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, RustProviderDiagnostic>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  const [refreshingQuotaProviderId, setRefreshingQuotaProviderId] = useState<string | null>(null);
  const [updatingQuotaProviderId, setUpdatingQuotaProviderId] = useState<string | null>(null);
  const [resettingHealthProviderId, setResettingHealthProviderId] = useState<string | null>(null);
  const [configuringHealthProviderId, setConfiguringHealthProviderId] = useState<string | null>(
    null
  );
  const [oauthDialog, setOauthDialog] = useState<{
    provider: RustProviderOAuthKind;
    connectionId?: string;
  } | null>(null);
  const [sessionImportOpen, setSessionImportOpen] = useState(false);

  const reload = useCallback(async () => {
    const [providerResult, catalogResult, quotaResult, healthResult] = await Promise.allSettled([
      listRustProviders(),
      readRustModelCatalog(),
      listRustProviderQuotas(),
      listRustProviderHealth(),
    ]);
    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value);
      setCatalogError(null);
    } else {
      setCatalogError(errorMessage(catalogResult.reason));
    }
    if (quotaResult.status === "fulfilled") {
      setProviderQuotas(
        Object.fromEntries(quotaResult.value.map((quota) => [quota.provider_id, quota]))
      );
      setQuotaDrafts((current) =>
        Object.fromEntries(
          quotaResult.value.map((quota) => [
            quota.provider_id,
            current[quota.provider_id] ?? quotaDraftFromQuota(quota),
          ])
        )
      );
      setQuotaError(null);
    } else {
      setQuotaError(errorMessage(quotaResult.reason));
    }
    if (healthResult.status === "fulfilled") {
      setProviderHealth(
        Object.fromEntries(healthResult.value.map((health) => [health.provider_id, health]))
      );
      setHealthDrafts((current) =>
        Object.fromEntries(
          healthResult.value.map((health) => [
            health.provider_id,
            current[health.provider_id] ?? {
              failureThreshold: String(health.failure_threshold),
              degradationThreshold: String(health.degradation_threshold),
              resetTimeoutMs: String(health.reset_timeout_ms),
            },
          ])
        )
      );
      setHealthError(null);
    } else {
      setHealthError(errorMessage(healthResult.reason));
    }
    if (providerResult.status === "rejected") throw providerResult.reason;
    setProviders(providerResult.value);
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await reload();
    })()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [reload]);

  const enabledCount = useMemo(
    () => providers.filter((provider) => provider.enabled).length,
    [providers]
  );
  const catalogNames = useMemo(
    () => new Map(catalog?.providers.map((provider) => [provider.id, provider.name]) ?? []),
    [catalog]
  );
  const selectedCatalogProvider = useMemo(
    () => catalog?.providers.find((provider) => provider.id === draft.provider.trim()) ?? null,
    [catalog, draft.provider]
  );

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = providerInput(draft, editingId !== null);
      await replaceRustProvider(draft.id.trim(), input);
      reset();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const disable = async (provider: RustProvider) => {
    if (!window.confirm(`Disable provider connection “${provider.id}”?`)) return;
    setSaving(true);
    setError(null);
    try {
      await disableRustProvider(provider.id);
      if (editingId === provider.id) reset();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: RustProvider) => {
    if (provider.enabled) {
      setError("Disable the provider before permanently removing it");
      return;
    }
    if (
      !window.confirm(
        `Permanently remove provider connection “${provider.id}”? Usage and audit history are retained, but encrypted credentials and provider runtime state are deleted.`
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteRustProvider(provider.id);
      if (editingId === provider.id) reset();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const refreshCatalog = async () => {
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      await refreshRustModelCatalog();
      setCatalog(await readRustModelCatalog());
      setCatalogProvider(null);
    } catch (cause) {
      setCatalogError(errorMessage(cause));
    } finally {
      setCatalogBusy(false);
    }
  };

  const inspectCatalogProvider = async () => {
    const id = draft.provider.trim();
    if (!id) return;
    setCatalogBusy(true);
    setCatalogError(null);
    try {
      setCatalogProvider(await readRustCatalogProvider(id));
    } catch (cause) {
      setCatalogError(errorMessage(cause));
    } finally {
      setCatalogBusy(false);
    }
  };

  const testConnection = async (provider: RustProvider) => {
    const model = diagnosticModels[provider.id]?.trim() ?? "";
    if (!model || model.length > 256) {
      setError("Enter an exact provider model ID (maximum 256 characters) before testing");
      return;
    }
    setTestingProviderId(provider.id);
    setError(null);
    try {
      const result = await testRustProvider(provider.id, model);
      setDiagnostics((current) => ({ ...current, [provider.id]: result }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTestingProviderId(null);
    }
  };

  const refreshOAuth = async (provider: RustProvider) => {
    setRefreshingProviderId(provider.id);
    setError(null);
    try {
      const result = await refreshRustProviderOAuth(provider.id);
      if (!result.ok && result.category !== "refresh_in_progress") {
        setError(`OAuth refresh requires attention: ${result.category.replaceAll("_", " ")}`);
      }
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshingProviderId(null);
    }
  };

  const refreshQuota = async (provider: RustProvider) => {
    setRefreshingQuotaProviderId(provider.id);
    setQuotaError(null);
    try {
      const result = await refreshRustProviderQuota(provider.id);
      setQuotaRefreshCategories((current) => ({
        ...current,
        [provider.id]: result.category,
      }));
      const quota = result.quota;
      if (quota) {
        setProviderQuotas((current) => ({ ...current, [provider.id]: quota }));
        setQuotaDrafts((current) => ({
          ...current,
          [provider.id]: quotaDraftFromQuota(quota),
        }));
      }
    } catch (cause) {
      setQuotaError(errorMessage(cause));
    } finally {
      setRefreshingQuotaProviderId(null);
    }
  };

  const configureQuota = async (provider: RustProvider) => {
    const draft = quotaDrafts[provider.id] ?? quotaDraftFromQuota(providerQuotas[provider.id]);
    const parseWindow = (remainingValue: string, resetValue: string, label: string) => {
      const trimmed = remainingValue.trim();
      if (!trimmed) {
        if (resetValue) throw new Error(`${label} reset requires a remaining percentage`);
        return undefined;
      }
      const remainingPercent = Number(trimmed);
      if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
        throw new Error(`${label} remaining percentage must be between 0 and 100`);
      }
      const resetAt = resetValue ? new Date(resetValue) : null;
      if (resetAt && !Number.isFinite(resetAt.getTime())) {
        throw new Error(`${label} reset time is invalid`);
      }
      return {
        remaining_percent: remainingPercent,
        ...(resetAt ? { reset_at_unix_ms: resetAt.getTime() } : {}),
      };
    };

    setUpdatingQuotaProviderId(provider.id);
    setQuotaError(null);
    try {
      const session = parseWindow(draft.sessionRemainingPercent, draft.sessionResetAt, "Session");
      const weekly = parseWindow(draft.weeklyRemainingPercent, draft.weeklyResetAt, "Weekly");
      const ttlSeconds = Number(draft.ttlSeconds);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
        throw new Error("Quota TTL must be an integer from 1 to 86400 seconds");
      }
      if (!session && !weekly && !draft.limitReached) {
        throw new Error("Set a session or weekly window, or mark the provider as exhausted");
      }
      const quota = await configureRustProviderQuota(provider.id, {
        ...(session ? { session } : {}),
        ...(weekly ? { weekly } : {}),
        limit_reached: draft.limitReached,
        ttl_seconds: ttlSeconds,
      });
      setProviderQuotas((current) => ({ ...current, [provider.id]: quota }));
      setQuotaDrafts((current) => ({
        ...current,
        [provider.id]: quotaDraftFromQuota(quota),
      }));
      setQuotaRefreshCategories((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (cause) {
      setQuotaError(errorMessage(cause));
    } finally {
      setUpdatingQuotaProviderId(null);
    }
  };

  const clearQuota = async (provider: RustProvider) => {
    if (
      !window.confirm(
        `Clear the quota snapshot for “${provider.id}”? Routing will treat quota as unknown until the next refresh or manual override.`
      )
    ) {
      return;
    }
    setUpdatingQuotaProviderId(provider.id);
    setQuotaError(null);
    try {
      await clearRustProviderQuota(provider.id);
      setProviderQuotas((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      setQuotaDrafts((current) => ({ ...current, [provider.id]: EMPTY_QUOTA_DRAFT }));
      setQuotaRefreshCategories((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (cause) {
      setQuotaError(errorMessage(cause));
    } finally {
      setUpdatingQuotaProviderId(null);
    }
  };

  const resetHealth = async (provider: RustProvider) => {
    setResettingHealthProviderId(provider.id);
    setHealthError(null);
    try {
      await resetRustProviderHealth(provider.id);
      await reload();
    } catch (cause) {
      setHealthError(errorMessage(cause));
    } finally {
      setResettingHealthProviderId(null);
    }
  };

  const configureHealth = async (provider: RustProvider) => {
    const draft = healthDrafts[provider.id];
    if (!draft) return;
    const failureThreshold = Number(draft.failureThreshold);
    const degradationThreshold = Number(draft.degradationThreshold);
    const resetTimeoutMs = Number(draft.resetTimeoutMs);
    if (
      !Number.isSafeInteger(failureThreshold) ||
      failureThreshold < 1 ||
      failureThreshold > 1_000 ||
      !Number.isSafeInteger(degradationThreshold) ||
      degradationThreshold < 1 ||
      degradationThreshold > failureThreshold ||
      !Number.isSafeInteger(resetTimeoutMs) ||
      resetTimeoutMs < 1_000 ||
      resetTimeoutMs > 86_400_000
    ) {
      setHealthError(
        "Circuit thresholds must be integers from 1 to 1000, degradation cannot exceed failure, and reset timeout must be 1000–86400000 ms."
      );
      return;
    }
    setConfiguringHealthProviderId(provider.id);
    setHealthError(null);
    try {
      await configureRustProviderHealth(provider.id, {
        failure_threshold: failureThreshold,
        degradation_threshold: degradationThreshold,
        reset_timeout_ms: resetTimeoutMs,
      });
      await reload();
    } catch (cause) {
      setHealthError(errorMessage(cause));
    } finally {
      setConfiguringHealthProviderId(null);
    }
  };

  const set = <K extends keyof Draft>(name: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [name]: value }));

  return (
    <div className="flex flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text">Provider connections</h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            Managed directly by the Rust proxy. Credentials are encrypted by the backend and are
            never returned to this page.
          </p>
        </div>
        <div className="rounded-full bg-black/5 px-3 py-1 text-xs text-text-muted dark:bg-white/5">
          {enabledCount} enabled / {providers.length} configured
        </div>
      </div>

      {error && (
        <div
          className="rounded-lg border border-feedback-danger-border bg-feedback-danger-surface p-3 text-sm text-feedback-danger-foreground"
          role="alert"
        >
          {error}
        </div>
      )}

      {quotaError && (
        <div
          className="rounded-lg border border-feedback-warning-border bg-feedback-warning-surface p-3 text-sm text-feedback-warning-foreground"
          role="status"
        >
          Provider quota telemetry is temporarily unavailable: {quotaError}. Existing routing and
          the last valid backend snapshot remain active.
        </div>
      )}

      {healthError && (
        <div
          className="rounded-lg border border-feedback-warning-border bg-feedback-warning-surface p-3 text-sm text-feedback-warning-foreground"
          role="status"
        >
          Provider health telemetry is temporarily unavailable: {healthError}. Routing continues
          with the last durable breaker state.
        </div>
      )}

      <Card
        title="models.dev catalog"
        subtitle="Validated and cached by red-routerd; the browser never downloads upstream catalog data directly."
        action={
          <Button variant="secondary" loading={catalogBusy} onClick={() => void refreshCatalog()}>
            Refresh catalog
          </Button>
        }
      >
        {catalog ? (
          <dl className="grid gap-3 text-xs text-text-muted sm:grid-cols-2 xl:grid-cols-5">
            <div>
              <dt className="font-medium">Active source</dt>
              <dd>{catalog.snapshot.source}</dd>
            </div>
            <div>
              <dt className="font-medium">Providers</dt>
              <dd>{catalog.manifest.providers.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="font-medium">Provider models</dt>
              <dd>{catalog.manifest.providerModels.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="font-medium">Fetched</dt>
              <dd>{catalogDate(catalog.manifest.fetchedAt)}</dd>
            </div>
            <div>
              <dt className="font-medium">Revision</dt>
              <dd className="truncate font-mono">{catalog.snapshot.revision ?? "bundled"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-text-muted">Catalog metadata is unavailable.</p>
        )}
        {(catalogError || catalog?.snapshot.last_error) && (
          <p className="mt-3 text-xs text-feedback-warning-foreground" role="status">
            {catalogError ?? catalog?.snapshot.last_error}. Manual refresh requires a global
            administrator; the last validated snapshot remains active.
          </p>
        )}
      </Card>

      <Card
        title="Provider browser sign-in"
        subtitle="Connect supported CLI accounts without copying access or refresh tokens into the dashboard. OAuth state, token exchange and encrypted persistence stay in Rust."
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setOauthDialog({ provider: "codex" })}>
            Connect OpenAI Codex
          </Button>
          <Button variant="secondary" onClick={() => setOauthDialog({ provider: "claude" })}>
            Connect Claude Code
          </Button>
          <Button variant="secondary" onClick={() => setOauthDialog({ provider: "agy" })}>
            Connect Antigravity
          </Button>
          <Button variant="secondary" onClick={() => setSessionImportOpen(true)}>
            Import existing CLI sessions
          </Button>
        </div>
        <p className="mt-3 text-xs text-text-muted">
          API keys and custom OpenAI-compatible endpoints remain available in the manual connection
          form below.
        </p>
      </Card>

      <Card
        title={editingId ? `Replace ${editingId}` : "Add provider connection"}
        subtitle={
          editingId
            ? "Saving replaces the runtime connection atomically, so enter the credential again."
            : "The connection ID is the stable identifier used by policies, combos and client keys."
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className={labelClass}>
            Connection ID
            <input
              className={inputClass}
              value={draft.id}
              disabled={editingId !== null}
              placeholder="openrouter-main"
              onChange={(event) => set("id", event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Connection label
            <input
              className={inputClass}
              value={draft.label}
              placeholder={draft.id.trim() || "OpenRouter production"}
              maxLength={128}
              onChange={(event) => set("label", event.target.value)}
            />
          </label>
          <div className={labelClass}>
            <span>Provider type</span>
            <input
              className={inputClass}
              list="rust-model-catalog-providers"
              value={draft.provider}
              placeholder="openai-compatible"
              onChange={(event) => {
                set("provider", event.target.value);
                setCatalogProvider(null);
              }}
            />
            <datalist id="rust-model-catalog-providers">
              {catalog?.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name ?? provider.id}
                </option>
              ))}
            </datalist>
            <div className="flex min-h-5 items-center justify-between gap-2 font-normal">
              <span>{selectedCatalogProvider?.name ?? "Custom OpenAI-compatible provider"}</span>
              {selectedCatalogProvider && (
                <button
                  type="button"
                  className="text-primary hover:underline disabled:opacity-50"
                  disabled={catalogBusy}
                  onClick={() => void inspectCatalogProvider()}
                >
                  Inspect models
                </button>
              )}
            </div>
          </div>
          <label className={labelClass}>
            Rate-limit scope
            <select
              className={inputClass}
              value={draft.rateLimitScope}
              onChange={(event) => set("rateLimitScope", event.target.value as RustRateLimitScope)}
            >
              <option value="auto">Automatic</option>
              <option value="connection">Whole connection</option>
              <option value="model">Per model</option>
            </select>
          </label>
          <label className={labelClass}>
            Credential type
            <select
              className={inputClass}
              value={draft.credentialType}
              onChange={(event) => {
                const credentialType = event.target.value as Draft["credentialType"];
                setDraft((current) => ({
                  ...current,
                  credentialType,
                  ...(credentialType === "oauth"
                    ? {
                        provider: current.oauthProvider,
                        authScheme: "bearer" as RustProviderAuthScheme,
                      }
                    : {}),
                }));
              }}
            >
              <option value="static">API key or static token</option>
              <option value="oauth">Imported CLI OAuth session</option>
            </select>
          </label>
          {draft.credentialType === "oauth" && (
            <label className={labelClass}>
              OAuth account type
              <select
                className={inputClass}
                value={draft.oauthProvider}
                onChange={(event) => {
                  const oauthProvider = event.target.value as Draft["oauthProvider"];
                  setDraft((current) => ({
                    ...current,
                    oauthProvider,
                    provider: oauthProvider,
                    authScheme: "bearer",
                  }));
                }}
              >
                <option value="codex">OpenAI Codex CLI</option>
                <option value="claude">Claude Code</option>
                <option value="agy">Antigravity</option>
              </select>
            </label>
          )}
          <label className={labelClass}>
            Credential authentication
            <select
              className={inputClass}
              value={draft.authScheme}
              disabled={draft.credentialType === "oauth"}
              onChange={(event) => set("authScheme", event.target.value as RustProviderAuthScheme)}
            >
              <option value="auto">Automatic for endpoint</option>
              <option value="bearer">Authorization: Bearer</option>
              <option value="x-api-key">x-api-key</option>
              <option value="x-goog-api-key">x-goog-api-key</option>
            </select>
          </label>
          <label className={labelClass}>
            Provider account email (optional)
            <input
              className={inputClass}
              type="email"
              value={draft.accountEmail}
              placeholder="agent@example.com"
              maxLength={320}
              onChange={(event) => set("accountEmail", event.target.value)}
            />
          </label>
          <label className={`${labelClass} md:col-span-2`}>
            Upstream URL
            <input
              className={inputClass}
              type="url"
              value={draft.upstreamUrl}
              placeholder="https://openrouter.ai/api/v1"
              onChange={(event) => set("upstreamUrl", event.target.value)}
            />
          </label>
          <label className={labelClass}>
            {draft.credentialType === "oauth"
              ? "OAuth access token"
              : "API key or provider credential"}
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={draft.apiKey}
              placeholder={
                editingId ? "Leave blank to keep current credential" : "Stored encrypted"
              }
              onChange={(event) => set("apiKey", event.target.value)}
            />
          </label>
          {draft.credentialType === "oauth" && (
            <label className={labelClass}>
              OAuth refresh token
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={draft.refreshToken}
                placeholder={
                  editingId ? "Leave blank to keep current refresh token" : "Stored encrypted"
                }
                onChange={(event) => set("refreshToken", event.target.value)}
              />
            </label>
          )}
          <label className={labelClass}>
            Credential expires {draft.credentialType === "oauth" ? "(required)" : "(optional)"}
            <input
              className={inputClass}
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(event) => set("expiresAt", event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 self-end rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/10">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            Enabled after save
          </label>
        </div>
        {catalogProvider?.id === draft.provider.trim() && (
          <div className="mt-4 rounded-lg border border-black/10 p-3 text-xs dark:border-white/10">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-text">
                {catalogProvider.name ?? catalogProvider.id}: {catalogProvider.models.length} models
              </strong>
              <span className="text-text-muted">First 12 shown</span>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {catalogProvider.models.slice(0, 12).map((model) => (
                <div key={model.id} className="rounded bg-black/[0.03] p-2 dark:bg-white/[0.03]">
                  <div className="truncate font-mono text-text">{model.id}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-text-muted">
                    {model.limit?.context && (
                      <span>{model.limit.context.toLocaleString()} context</span>
                    )}
                    {model.reasoning && <span>· reasoning</span>}
                    {model.tool_call && <span>· tools</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button loading={saving} onClick={() => void save()}>
            {editingId ? "Replace connection" : "Add connection"}
          </Button>
          {editingId && (
            <Button variant="secondary" disabled={saving} onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {loading ? (
          <div className="text-sm text-text-muted" role="status">
            Loading provider connections…
          </div>
        ) : providers.length === 0 ? (
          <Card>
            <p className="text-sm text-text-muted">No provider connections configured in Rust.</p>
          </Card>
        ) : (
          providers.map((provider) => {
            const quota = providerQuotas[provider.id];
            const quotaDraft = quotaDrafts[provider.id] ?? quotaDraftFromQuota(quota);
            const health = providerHealth[provider.id];
            const healthDraft = healthDrafts[provider.id];
            const quotaExpired = quota ? quota.expires_at_unix_ms <= Date.now() : false;
            const canRefreshQuota = supportsQuotaRefresh(provider);
            const quotaRefreshCategory = quotaRefreshCategories[provider.id];
            const unhealthy = Boolean(
              health &&
              (health.state !== "closed" ||
                health.connection_retry_after_ms > 0 ||
                health.terminal_status ||
                health.ambiguous_auth_strikes > 0 ||
                health.model_lockouts.length > 0)
            );
            return (
              <Card
                key={provider.id}
                title={provider.label}
                subtitle={`${provider.id} · ${catalogNames.get(provider.provider) ?? provider.provider} · tenant ${provider.tenant_id}`}
                action={
                  <span
                    className={`rounded-full px-2 py-1 text-xs ${
                      provider.enabled
                        ? "bg-feedback-success-surface text-feedback-success-foreground"
                        : "bg-black/5 text-text-muted dark:bg-white/5"
                    }`}
                  >
                    {provider.enabled ? "Enabled" : "Disabled"}
                  </span>
                }
              >
                <dl className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Upstream</dt>
                    <dd className="break-all">{provider.upstream_url}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Rate limits</dt>
                    <dd>{provider.rate_limit_scope}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Credential</dt>
                    <dd>
                      {provider.credential_expired
                        ? "Expired"
                        : provider.has_credential
                          ? provider.credential_type === "oauth"
                            ? `${provider.oauth_provider} OAuth · generation ${provider.oauth_generation}`
                            : "Encrypted and present"
                          : "Missing"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Authentication</dt>
                    <dd>{provider.auth_scheme}</dd>
                  </div>
                  {provider.account_email && (
                    <div>
                      <dt className="font-medium">Provider account</dt>
                      <dd className="break-all">{provider.account_email}</dd>
                    </div>
                  )}
                  {provider.expires_at_unix && (
                    <div>
                      <dt className="font-medium">Credential expiry</dt>
                      <dd>{new Date(provider.expires_at_unix * 1_000).toLocaleString()}</dd>
                    </div>
                  )}
                  {provider.refreshable && (
                    <div>
                      <dt className="font-medium">OAuth refresh</dt>
                      <dd
                        className={
                          provider.reauth_required ? "text-feedback-danger-foreground" : undefined
                        }
                      >
                        {provider.reauth_required
                          ? `Sign-in required${provider.oauth_error_code ? ` · ${provider.oauth_error_code}` : ""}`
                          : "Ready · automatic before expiry"}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-medium">Revision</dt>
                    <dd className="truncate font-mono">{provider.revision}</dd>
                  </div>
                </dl>
                {health && (
                  <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/10">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-text">Runtime health</div>
                        <div className="mt-2 grid gap-1 text-xs text-text-muted sm:grid-cols-2">
                          <div>
                            Circuit: <span className="font-medium text-text">{health.state}</span>
                            {health.failure_count > 0
                              ? " · " + health.failure_count + " failures"
                              : ""}
                          </div>
                          <div>
                            Cooldown:{" "}
                            <span className="font-medium text-text">
                              {health.connection_retry_after_ms > 0
                                ? health.terminal_status
                                  ? "blocked"
                                  : health.connection_retry_after_ms + " ms"
                                : "ready"}
                            </span>
                          </div>
                          {health.connection_last_status !== null && (
                            <div>Last upstream status: HTTP {health.connection_last_status}</div>
                          )}
                          {health.terminal_status && (
                            <div className="text-feedback-danger-foreground">
                              Account state: {health.terminal_status.replaceAll("_", " ")}
                            </div>
                          )}
                          {health.ambiguous_auth_strikes > 0 && (
                            <div>
                              Ambiguous auth failures: {health.ambiguous_auth_strikes}/
                              {health.ambiguous_auth_retry_limit}
                            </div>
                          )}
                          {health.model_lockouts.length > 0 && (
                            <div>Model lockouts: {health.model_lockouts.length}</div>
                          )}
                        </div>
                      </div>
                      <span
                        className={
                          unhealthy
                            ? "rounded-full bg-feedback-warning-surface px-2 py-1 text-xs text-feedback-warning-foreground"
                            : "rounded-full bg-feedback-success-surface px-2 py-1 text-xs text-feedback-success-foreground"
                        }
                      >
                        {unhealthy ? "Degraded" : "Healthy"}
                      </span>
                    </div>
                    {health.model_lockouts.length > 0 && (
                      <div className="mt-2 space-y-1 text-xs text-text-muted">
                        {health.model_lockouts.map((lockout) => (
                          <div key={lockout.model} className="break-all font-mono">
                            {lockout.model} · HTTP {lockout.status} · retry in{" "}
                            {lockout.retry_after_ms} ms
                          </div>
                        ))}
                      </div>
                    )}
                    {healthDraft && (
                      <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className={labelClass}>
                            Failure threshold
                            <input
                              className={inputClass}
                              type="number"
                              min={1}
                              max={1000}
                              value={healthDraft.failureThreshold}
                              onChange={(event) =>
                                setHealthDrafts((current) => ({
                                  ...current,
                                  [provider.id]: {
                                    ...healthDraft,
                                    failureThreshold: event.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                          <label className={labelClass}>
                            Degradation threshold
                            <input
                              className={inputClass}
                              type="number"
                              min={1}
                              max={1000}
                              value={healthDraft.degradationThreshold}
                              onChange={(event) =>
                                setHealthDrafts((current) => ({
                                  ...current,
                                  [provider.id]: {
                                    ...healthDraft,
                                    degradationThreshold: event.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                          <label className={labelClass}>
                            Reset timeout (ms)
                            <input
                              className={inputClass}
                              type="number"
                              min={1000}
                              max={86400000}
                              value={healthDraft.resetTimeoutMs}
                              onChange={(event) =>
                                setHealthDrafts((current) => ({
                                  ...current,
                                  [provider.id]: {
                                    ...healthDraft,
                                    resetTimeoutMs: event.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                        </div>
                        <div className="mt-2">
                          <Button
                            variant="secondary"
                            loading={configuringHealthProviderId === provider.id}
                            disabled={
                              configuringHealthProviderId !== null &&
                              configuringHealthProviderId !== provider.id
                            }
                            onClick={() => void configureHealth(provider)}
                          >
                            Save breaker policy
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/10">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-text">Provider quota</div>
                      {quota ? (
                        <div className="mt-2 grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                          {quota.session && (
                            <div>
                              <span className="font-medium text-text">Session: </span>
                              {quotaPercent(quota.session.remaining_percent)}
                              {quota.session.reset_at_unix_ms
                                ? ` · resets ${quotaDate(quota.session.reset_at_unix_ms)}`
                                : ""}
                            </div>
                          )}
                          {quota.weekly && (
                            <div>
                              <span className="font-medium text-text">Weekly: </span>
                              {quotaPercent(quota.weekly.remaining_percent)}
                              {quota.weekly.reset_at_unix_ms
                                ? ` · resets ${quotaDate(quota.weekly.reset_at_unix_ms)}`
                                : ""}
                            </div>
                          )}
                          <div>Observed {quotaDate(quota.observed_at_unix_ms)}</div>
                          <div>Valid until {quotaDate(quota.expires_at_unix_ms)}</div>
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-text-muted">
                          No quota snapshot collected yet.
                        </p>
                      )}
                    </div>
                    {quota && (
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${
                          quotaExpired
                            ? "bg-feedback-warning-surface text-feedback-warning-foreground"
                            : quota.limit_reached
                              ? "bg-feedback-danger-surface text-feedback-danger-foreground"
                              : "bg-feedback-success-surface text-feedback-success-foreground"
                        }`}
                      >
                        {quotaExpired
                          ? "Expired"
                          : quota.limit_reached
                            ? "Limit reached"
                            : "Current"}
                      </span>
                    )}
                  </div>
                  {quota?.models && quota.models.length > 0 && (
                    <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
                      <div className="text-xs font-medium text-text">Model quotas</div>
                      <div className="mt-2 grid gap-2">
                        {quota.models.map((modelQuota) => {
                          const expired = modelQuota.expires_at_unix_ms <= Date.now();
                          return (
                            <div
                              key={modelQuota.model_id}
                              className="rounded-md bg-black/[0.025] px-2.5 py-2 text-xs text-text-muted dark:bg-white/[0.04]"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="break-all font-mono text-text">
                                  {modelQuota.model_id}
                                </span>
                                <span
                                  className={
                                    expired
                                      ? "text-feedback-warning-foreground"
                                      : modelQuota.limit_reached
                                        ? "text-feedback-danger-foreground"
                                        : "text-feedback-success-foreground"
                                  }
                                >
                                  {expired
                                    ? "Expired"
                                    : modelQuota.limit_reached
                                      ? "Limit reached"
                                      : "Current"}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                {modelQuota.session && (
                                  <span>
                                    Session {quotaPercent(modelQuota.session.remaining_percent)}
                                  </span>
                                )}
                                {modelQuota.weekly && (
                                  <span>
                                    Weekly {quotaPercent(modelQuota.weekly.remaining_percent)}
                                  </span>
                                )}
                                <span>Valid until {quotaDate(modelQuota.expires_at_unix_ms)}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {quotaRefreshCategory && quotaRefreshCategory !== "refreshed" && (
                    <p className="mt-2 text-xs text-feedback-warning-foreground" role="status">
                      Latest refresh: {quotaRefreshCategory.replaceAll("_", " ")}. The last valid
                      snapshot was preserved.
                    </p>
                  )}
                  {canRefreshQuota && provider.enabled && (
                    <div className="mt-3">
                      <Button
                        variant="secondary"
                        loading={refreshingQuotaProviderId === provider.id}
                        disabled={
                          refreshingQuotaProviderId !== null &&
                          refreshingQuotaProviderId !== provider.id
                        }
                        onClick={() => void refreshQuota(provider)}
                      >
                        Refresh quota
                      </Button>
                    </div>
                  )}
                  <details className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
                    <summary className="cursor-pointer text-xs font-medium text-text">
                      Manual quota override
                    </summary>
                    <p className="mt-2 text-xs text-text-muted">
                      Replaces the current provider and model quota snapshot until it expires or an
                      automatic refresh succeeds.
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <label className={labelClass}>
                        Session remaining (%)
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          max={100}
                          step="any"
                          value={quotaDraft.sessionRemainingPercent}
                          aria-label={`Session quota remaining for ${provider.label}`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: {
                                ...quotaDraft,
                                sessionRemainingPercent: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        Session reset (optional)
                        <input
                          className={inputClass}
                          type="datetime-local"
                          value={quotaDraft.sessionResetAt}
                          aria-label={`Session quota reset for ${provider.label}`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: {
                                ...quotaDraft,
                                sessionResetAt: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        Weekly remaining (%)
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          max={100}
                          step="any"
                          value={quotaDraft.weeklyRemainingPercent}
                          aria-label={`Weekly quota remaining for ${provider.label}`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: {
                                ...quotaDraft,
                                weeklyRemainingPercent: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        Weekly reset (optional)
                        <input
                          className={inputClass}
                          type="datetime-local"
                          value={quotaDraft.weeklyResetAt}
                          aria-label={`Weekly quota reset for ${provider.label}`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: {
                                ...quotaDraft,
                                weeklyResetAt: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className={labelClass}>
                        Snapshot TTL (seconds)
                        <input
                          className={inputClass}
                          type="number"
                          min={1}
                          max={86400}
                          step={1}
                          value={quotaDraft.ttlSeconds}
                          aria-label={`Quota TTL for ${provider.label}`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: { ...quotaDraft, ttlSeconds: event.target.value },
                            }))
                          }
                        />
                      </label>
                      <label className="flex items-center gap-2 self-end rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/10">
                        <input
                          type="checkbox"
                          checked={quotaDraft.limitReached}
                          aria-label={`Mark ${provider.label} quota as exhausted`}
                          onChange={(event) =>
                            setQuotaDrafts((current) => ({
                              ...current,
                              [provider.id]: {
                                ...quotaDraft,
                                limitReached: event.target.checked,
                              },
                            }))
                          }
                        />
                        Limit reached
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        loading={updatingQuotaProviderId === provider.id}
                        disabled={
                          updatingQuotaProviderId !== null &&
                          updatingQuotaProviderId !== provider.id
                        }
                        onClick={() => void configureQuota(provider)}
                      >
                        Save manual quota
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={!quota || updatingQuotaProviderId !== null}
                        onClick={() => void clearQuota(provider)}
                      >
                        Clear quota
                      </Button>
                    </div>
                  </details>
                </div>
                {provider.enabled && (
                  <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/10">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        className={inputClass}
                        value={diagnosticModels[provider.id] ?? ""}
                        placeholder="Exact provider model ID"
                        maxLength={256}
                        disabled={testingProviderId === provider.id}
                        aria-label={`Model used to test ${provider.label}`}
                        onChange={(event) =>
                          setDiagnosticModels((current) => ({
                            ...current,
                            [provider.id]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        variant="secondary"
                        loading={testingProviderId === provider.id}
                        disabled={testingProviderId !== null && testingProviderId !== provider.id}
                        onClick={() => void testConnection(provider)}
                      >
                        Test connection
                      </Button>
                    </div>
                    {diagnostics[provider.id] && (
                      <p
                        className={`mt-2 text-xs ${
                          diagnostics[provider.id].ok
                            ? "text-feedback-success-foreground"
                            : "text-feedback-warning-foreground"
                        }`}
                        role="status"
                      >
                        {diagnostics[provider.id].ok ? "Connected" : "Test failed"}:{" "}
                        {diagnostics[provider.id].category.replaceAll("_", " ")}
                        {diagnostics[provider.id].upstream_status
                          ? ` · HTTP ${diagnostics[provider.id].upstream_status}`
                          : ""}
                        {` · ${diagnostics[provider.id].latency_ms} ms`}
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {provider.credential_type === "oauth" && provider.oauth_provider && (
                    <Button
                      variant="secondary"
                      disabled={saving}
                      onClick={() =>
                        setOauthDialog({
                          provider: provider.oauth_provider as RustProviderOAuthKind,
                          connectionId: provider.id,
                        })
                      }
                    >
                      Sign in again
                    </Button>
                  )}
                  {provider.enabled && provider.refreshable && (
                    <Button
                      variant="secondary"
                      loading={refreshingProviderId === provider.id}
                      disabled={
                        refreshingProviderId !== null && refreshingProviderId !== provider.id
                      }
                      onClick={() => void refreshOAuth(provider)}
                    >
                      Refresh OAuth
                    </Button>
                  )}
                  {unhealthy && (
                    <Button
                      variant="secondary"
                      loading={resettingHealthProviderId === provider.id}
                      disabled={
                        resettingHealthProviderId !== null &&
                        resettingHealthProviderId !== provider.id
                      }
                      onClick={() => void resetHealth(provider)}
                    >
                      Reset health
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={saving}
                    onClick={() => {
                      setEditingId(provider.id);
                      setDraft(providerDraft(provider));
                      setError(null);
                    }}
                  >
                    Replace
                  </Button>
                  {provider.enabled && (
                    <Button
                      variant="danger"
                      disabled={saving}
                      onClick={() => void disable(provider)}
                    >
                      Disable
                    </Button>
                  )}
                  {!provider.enabled && (
                    <Button
                      variant="danger"
                      disabled={saving}
                      onClick={() => void remove(provider)}
                    >
                      Remove permanently
                    </Button>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>
      {oauthDialog && (
        <RustProviderOAuthModal
          provider={oauthDialog.provider}
          connectionId={oauthDialog.connectionId}
          onClose={() => setOauthDialog(null)}
          onSuccess={async () => {
            setOauthDialog(null);
            try {
              await reload();
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}
        />
      )}
      {sessionImportOpen && (
        <RustProviderSessionImportModal
          onClose={() => setSessionImportOpen(false)}
          onImported={async () => {
            try {
              await reload();
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}
        />
      )}
    </div>
  );
}
