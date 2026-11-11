import { useCallback, useEffect, useState } from "react";
import { rustAdminFetch } from "@/lib/rustControlPlane/browserClient";

type Provider = { id: string; name: string | null };
type Model = { id: string; name?: string; limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }; modalities?: { input: string[]; output: string[] }; reasoning?: boolean; tool_call?: boolean };
type Catalog = { manifest: { fetchedAt: string; providers: number; providerModels: number }; snapshot: { source: string; last_error?: string }; providers: Provider[] };
const fieldClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

async function read(path: string, init?: RequestInit) {
  const response = await rustAdminFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

export default function ModelCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [providerId, setProviderId] = useState("");
  const [result, setResult] = useState<{ providerId: string; catalog: Catalog; models: Model[] } | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const value: Catalog = await read("/api/admin/model-catalog");
    if (!Array.isArray(value.providers)) throw new Error("Invalid catalog response.");
    setCatalog(value);
    setProviderId((current) => value.providers.some((provider) => provider.id === current) ? current : "");
  }, []);
  useEffect(() => { void Promise.resolve().then(load).catch((cause) => setError(cause instanceof Error ? cause.message : "Cannot load catalog.")); }, [load]);
  useEffect(() => {
    if (!providerId || !catalog) return;
    const controller = new AbortController();
    void read(`/api/admin/model-catalog/${encodeURIComponent(providerId)}`, { signal: controller.signal })
      .then(({ provider }) => {
        if (!Array.isArray(provider?.models)) throw new Error("Invalid provider catalog response.");
        if (!controller.signal.aborted) setResult({ providerId, catalog, models: provider.models });
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Cannot load models."); });
    return () => controller.abort();
  }, [providerId, catalog]);

  async function refresh() {
    setBusy(true); setError(""); setNotice("");
    try {
      const { snapshot } = await read("/api/admin/model-catalog/refresh", { method: "POST" });
      await load();
      setNotice(snapshot.changed ? "Catalog updated." : "Catalog is already up to date.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Cannot refresh catalog."); }
    finally { setBusy(false); }
  }
  const models = result?.providerId === providerId && result.catalog === catalog ? result.models : null;
  const filtered = models?.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const number = (value?: number) => value == null ? "—" : value.toLocaleString();
  const price = (value?: number) => value == null ? "—" : `$${value}`;
  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Model catalog</h1>
    <p>Descriptive metadata from models.dev. Listing a model does not configure a provider or grant access.</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!catalog ? <p>Loading catalog…</p> : <>
      <p>Snapshot: {catalog.manifest.fetchedAt} · {catalog.manifest.providers} providers · {catalog.manifest.providerModels} provider models · {catalog.snapshot.source}</p>
      {catalog.snapshot.last_error && <p role="alert">Last refresh failed: {catalog.snapshot.last_error}</p>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh catalog</button>
      <label className="block" htmlFor="catalog-provider">Provider</label>
      <select id="catalog-provider" className={fieldClass} value={providerId} onChange={(event) => { setProviderId(event.target.value); setQuery(""); setError(""); }}>
        <option value="">Select a provider</option>
        {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id} ({provider.id})</option>)}
      </select>
      {providerId && <>
        <label className="block">Filter models<input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {!models ? <p>Loading models…</p> : <div className="overflow-x-auto"><table className="w-full text-left">
          <thead><tr><th>Model</th><th>Context</th><th>Output limit</th><th>Input / 1M</th><th>Output / 1M</th><th>Modalities</th><th>Capabilities</th></tr></thead>
          <tbody>{filtered?.map((model) => <tr key={model.id}>
            <td>{model.name || model.id}<br /><small>{model.id}</small></td><td>{number(model.limit?.context)}</td><td>{number(model.limit?.output)}</td>
            <td>{price(model.cost?.input)}</td><td>{price(model.cost?.output)}</td>
            <td>{model.modalities ? `${model.modalities.input.join(", ")} → ${model.modalities.output.join(", ")}` : "—"}</td>
            <td>{[model.reasoning && "Reasoning", model.tool_call && "Tools"].filter(Boolean).join(", ") || "—"}</td>
          </tr>)}</tbody>
        </table>{filtered?.length === 0 && <p>No matching models.</p>}</div>}
      </>}
    </>}
  </section>;
}
