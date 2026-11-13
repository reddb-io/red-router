import { useEffect, useMemo, useState } from "react";
import { Button, Card } from "./components";
import {
  providerDiscoveryConfig,
  discoverProviderModels,
  adoptLegacyProviderModels,
  type ProviderDiscoveryConfig,
  type DiscoveredProviderModel,
} from "./api/browserClient";

export default function ProviderDiscovery({
  id,
  onSelect,
}: {
  id: string;
  onSelect: (model: string) => void;
}) {
  return <DiscoveryEditor key={id} id={id} onSelect={onSelect} />;
}

function DiscoveryEditor({ id, onSelect }: { id: string; onSelect: (model: string) => void }) {
  const [config, setConfig] = useState<ProviderDiscoveryConfig | null>(null);
  const [path, setPath] = useState("");
  const [models, setModels] = useState<DiscoveredProviderModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    providerDiscoveryConfig(id)
      .then((value) => {
        if (active) {
          setConfig(value);
          setPath(value.models_path ?? "");
          setError("");
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load discovery settings");
      });
    return () => {
      active = false;
    };
  }, [id, reload]);
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (models ?? []).filter((model) =>
      `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query)
    );
  }, [models, filter]);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const visiblePage = Math.min(page, pages - 1);
  async function save(reset: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const updated = await providerDiscoveryConfig(id, reset ? null : path.trim());
      setConfig(updated);
      setPath(updated.models_path ?? "");
      setModels(null);
      setPage(0);
      setMessage("Model discovery settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save discovery settings");
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    setBusy(true);
    setError("");
    setMessage("");
    setModels(null);
    try {
      setModels(await discoverProviderModels(id));
      setConfig((current) => current && { ...current, legacy_inventory_available: false });
      setPage(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discover models");
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const count = await adoptLegacyProviderModels(id);
      setConfig((current) => current && { ...current, legacy_inventory_available: false });
      setMessage(`Restored ${count} models. Their age is unknown; discover models to refresh availability.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore models");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Discover connection models"
      subtitle="Query the models available through this account using its saved credential and custom headers."
    >
      <p className="text-sm text-text-muted">
        Discovery uses the saved models path on the same host as this connection. Results do not
        create routes or change client permissions.
      </p>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        Models path override
        <input
          className="rounded-lg border border-border bg-surface p-2"
          value={path}
          maxLength={2048}
          placeholder={config?.effective_models_path ?? "/v1/models"}
          disabled={busy || !config}
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      {config && (
        <p className="mt-2 text-xs text-text-muted">
          Saved path: {config.effective_models_path ?? "Not configured"}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy || !config || !path.trim()} onClick={() => void save(false)}>
          Save models path
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !config?.models_path}
          onClick={() => void save(true)}
        >
          Use default path
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !config?.effective_models_path}
          onClick={() => void discover()}
        >
          Discover models
        </Button>
        {config?.legacy_inventory_available && (
          <Button variant="secondary" disabled={busy} onClick={() => void restore()}>
            Restore migrated models
          </Button>
        )}
        {!config && error && (
          <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
            Retry discovery settings
          </Button>
        )}
      </div>
      {busy && (
        <p role="status" className="mt-2 text-sm">
          Working…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      {models && (
        <div className="mt-4">
          <label className="flex flex-col gap-1 text-sm">
            Filter discovered models
            <input
              className="rounded-lg border border-border bg-surface p-2"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <p className="my-2 text-sm">
            {filtered.length} of {models.length} models · Page {visiblePage + 1} of {pages}
          </p>
          <ul className="divide-y divide-border">
            {filtered.slice(visiblePage * 50, (visiblePage + 1) * 50).map((model) => (
              <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <code className="break-all text-xs">{model.id}</code>
                  {model.name && model.name !== model.id && <p className="text-sm">{model.name}</p>}
                  <p className="text-xs text-text-muted">
                    Context: {model.context_length?.toLocaleString() ?? "Unknown"} · Max output:{" "}
                    {model.max_output_tokens?.toLocaleString() ?? "Unknown"}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    onSelect(model.id);
                    setMessage(`${model.id} selected for this connection's test below.`);
                  }}
                >
                  Use for test
                </Button>
              </li>
            ))}
          </ul>
          {filtered.length === 0 && <p className="text-sm text-text-muted">No matching models.</p>}
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              disabled={visiblePage === 0}
              onClick={() => setPage(visiblePage - 1)}
            >
              Previous models
            </Button>
            <Button
              variant="secondary"
              disabled={visiblePage + 1 >= pages}
              onClick={() => setPage(visiblePage + 1)}
            >
              Next models
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
