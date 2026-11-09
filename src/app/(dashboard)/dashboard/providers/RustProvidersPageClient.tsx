"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import {
  disableRustProvider,
  listRustProviders,
  replaceRustProvider,
  type RustProvider,
  type RustProviderInput,
  type RustRateLimitScope,
} from "@/lib/rustControlPlane/browserClient";

type Draft = {
  id: string;
  provider: string;
  upstreamUrl: string;
  apiKey: string;
  enabled: boolean;
  rateLimitScope: RustRateLimitScope;
};

const EMPTY_DRAFT: Draft = {
  id: "",
  provider: "openai-compatible",
  upstreamUrl: "",
  apiKey: "",
  enabled: true,
  rateLimitScope: "auto",
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
  };
}

function providerInput(draft: Draft): RustProviderInput {
  const id = draft.id.trim();
  const provider = draft.provider.trim();
  const upstreamUrl = draft.upstreamUrl.trim();
  const apiKey = draft.apiKey;
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Connection ID must contain only letters, numbers, dashes or underscores");
  }
  if (!provider || provider.length > 64 || !/^[a-z0-9-]+$/.test(provider)) {
    throw new Error("Provider type must use lowercase letters, numbers or dashes");
  }
  if (!apiKey || new TextEncoder().encode(apiKey).length > 512) {
    throw new Error("A provider credential between 1 and 512 bytes is required for every save");
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
  return {
    provider,
    upstream_url: upstreamUrl,
    api_key: apiKey,
    enabled: draft.enabled,
    rate_limit_scope: draft.rateLimitScope,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Rust control-plane request failed";
}

export default function RustProvidersPageClient() {
  const [providers, setProviders] = useState<RustProvider[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProviders(await listRustProviders());
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await refresh();
    })()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [refresh]);

  const enabledCount = useMemo(
    () => providers.filter((provider) => provider.enabled).length,
    [providers]
  );

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = providerInput(draft);
      await replaceRustProvider(draft.id.trim(), input);
      reset();
      await refresh();
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
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
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
            Provider type
            <input
              className={inputClass}
              value={draft.provider}
              placeholder="openai-compatible"
              onChange={(event) => set("provider", event.target.value)}
            />
          </label>
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
            API key or provider credential
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={draft.apiKey}
              placeholder={editingId ? "Required to replace" : "Stored encrypted"}
              onChange={(event) => set("apiKey", event.target.value)}
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
          providers.map((provider) => (
            <Card
              key={provider.id}
              title={provider.id}
              subtitle={`${provider.provider} · tenant ${provider.tenant_id}`}
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
                  <dd>{provider.has_credential ? "Encrypted and present" : "Missing"}</dd>
                </div>
                <div>
                  <dt className="font-medium">Revision</dt>
                  <dd className="truncate font-mono">{provider.revision}</dd>
                </div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
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
                  <Button variant="danger" disabled={saving} onClick={() => void disable(provider)}>
                    Disable
                  </Button>
                )}
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
