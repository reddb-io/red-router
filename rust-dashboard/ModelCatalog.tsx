import { useCallback, useEffect, useMemo, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";
import {
  catalogCapabilities,
  catalogPage,
  emptyCatalogFilters,
  selectCatalogModels,
  type CatalogModel as Model,
  type CatalogFilters,
  type CatalogSort,
} from "./catalogModels";
import { Button } from "./components";

type Provider = { id: string; name: string | null };
type Catalog = {
  manifest: {
    fetchedAt: string;
    providers: number;
    providerModels: number;
    contentSha256?: string;
  };
  snapshot: { source: string; last_error?: string };
  providers: Provider[];
};
type SearchPage = {
  models: Model[];
  total: number;
  offset: number;
  limit: number;
  types: string[];
  input_modalities: string[];
};
const ALL_PROVIDERS = "__all__";
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
  const [result, setResult] = useState<{
    providerId: string;
    catalog: Catalog;
    models: Model[];
  } | null>(null);
  const [filters, setFilters] = useState<CatalogFilters>(emptyCatalogFilters);
  const [sort, setSort] = useState<CatalogSort>("id");
  const [descending, setDescending] = useState(false);
  const [requestedPage, setRequestedPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [modelsError, setModelsError] = useState("");
  const [searchResult, setSearchResult] = useState<{
    key: string;
    catalog: Catalog;
    page: SearchPage;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const value: Catalog = await read("/api/admin/model-catalog");
    if (!Array.isArray(value.providers)) throw new Error("Invalid catalog response.");
    setCatalog(value);
    setProviderId((current) =>
      current === ALL_PROVIDERS || value.providers.some((provider) => provider.id === current)
        ? current
        : ""
    );
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(load)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Cannot load catalog."));
  }, [load]);
  useEffect(() => {
    if (!providerId || providerId === ALL_PROVIDERS || !catalog) return;
    const controller = new AbortController();
    void read(`/api/admin/model-catalog/${encodeURIComponent(providerId)}`, {
      signal: controller.signal,
    })
      .then(({ provider }) => {
        if (!Array.isArray(provider?.models)) throw new Error("Invalid provider catalog response.");
        if (!controller.signal.aborted) {
          setResult({ providerId, catalog, models: provider.models });
          setModelsError("");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setModelsError(cause instanceof Error ? cause.message : "Cannot load models.");
      });
    return () => controller.abort();
  }, [providerId, catalog, retry]);

  const globalSearch = providerId === ALL_PROVIDERS;
  const searchKey = new URLSearchParams({
    query: filters.query,
    model_type: filters.type,
    capability: filters.capability,
    input_modality: filters.inputModality,
    min_context: String(filters.minContext),
    sort,
    descending: String(descending),
    offset: String(requestedPage * 50),
    limit: "50",
    ...(catalog?.manifest.contentSha256 ? { snapshot: catalog.manifest.contentSha256 } : {}),
  }).toString();
  useEffect(() => {
    if (!globalSearch || !catalog) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void read(`/api/admin/model-catalog/search/models?${searchKey}`, {
        signal: controller.signal,
      })
        .then((page: SearchPage) => {
          if (
            !Array.isArray(page.models) ||
            !Number.isSafeInteger(page.total) ||
            page.total < 0 ||
            !Number.isSafeInteger(page.offset) ||
            page.offset < 0 ||
            !Number.isSafeInteger(page.limit) ||
            page.limit < 1 ||
            page.limit > 100 ||
            page.models.length > page.limit ||
            !Array.isArray(page.types) ||
            !Array.isArray(page.input_modalities)
          )
            throw new Error("Invalid catalog search response.");
          if (!controller.signal.aborted) {
            setSearchResult({ key: searchKey, catalog, page });
            setModelsError("");
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setModelsError(cause instanceof Error ? cause.message : "Cannot search models.");
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [globalSearch, searchKey, catalog, retry]);

  async function refresh() {
    setBusy(true);
    setError("");
    setModelsError("");
    setNotice("");
    try {
      const { snapshot } = await read("/api/admin/model-catalog/refresh", { method: "POST" });
      await load();
      setNotice(snapshot.changed ? "Catalog updated." : "Catalog is already up to date.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cannot refresh catalog.");
    } finally {
      setBusy(false);
    }
  }
  const globalPage =
    searchResult?.key === searchKey && searchResult.catalog === catalog ? searchResult.page : null;
  const models = globalSearch
    ? (globalPage?.models ?? null)
    : result?.providerId === providerId && result.catalog === catalog
      ? result.models
      : null;
  const filtered = useMemo(
    () => selectCatalogModels(models ?? [], filters, sort, descending),
    [models, filters, sort, descending]
  );
  const pagination = globalSearch
    ? {
        page: Math.floor((globalPage?.offset ?? 0) / (globalPage?.limit ?? 50)),
        pageCount: Math.max(1, Math.ceil((globalPage?.total ?? 0) / (globalPage?.limit ?? 50))),
        rows: globalPage?.models ?? [],
      }
    : catalogPage(filtered, requestedPage);
  const matchedCount = globalSearch ? (globalPage?.total ?? 0) : filtered.length;
  const totalCount = globalSearch ? (catalog?.manifest.providerModels ?? 0) : (models?.length ?? 0);
  const globalFacets = searchResult?.catalog === catalog ? searchResult?.page : null;
  const types = globalSearch
    ? (globalFacets?.types ?? [])
    : [...new Set(models?.flatMap((model) => (model.type ? [model.type] : [])) ?? [])].sort();
  const inputModalities = globalSearch
    ? (globalFacets?.input_modalities ?? [])
    : [...new Set(models?.flatMap((model) => model.modalities?.input ?? []) ?? [])].sort();
  function filter(next: Partial<CatalogFilters>) {
    setModelsError("");
    setFilters((current) => ({ ...current, ...next }));
    setRequestedPage(0);
  }
  const number = (value?: number) => (value == null ? "—" : value.toLocaleString());
  const price = (value?: number) => (value == null ? "—" : `$${value}`);
  return (
    <section className="space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Model catalog</h1>
      <p>
        Descriptive metadata from models.dev. Listing a model does not configure a provider or grant
        access.
      </p>
      {error && (
        <div role="alert" className="text-error">
          <p>{error}</p>
          {!catalog && (
            <Button
              onClick={() => {
                setError("");
                void load().catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Cannot load catalog.")
                );
              }}
            >
              Retry catalog
            </Button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {!catalog ? (
        !error && <p>Loading catalog…</p>
      ) : (
        <>
          <p>
            Snapshot: {catalog.manifest.fetchedAt} · {catalog.manifest.providers} providers ·{" "}
            {catalog.manifest.providerModels} provider models · {catalog.snapshot.source}
          </p>
          {catalog.snapshot.last_error && (
            <p role="alert">Last refresh failed: {catalog.snapshot.last_error}</p>
          )}
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            Refresh catalog
          </button>
          <label className="block" htmlFor="catalog-provider">
            Provider
          </label>
          <select
            id="catalog-provider"
            className={fieldClass}
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setFilters(emptyCatalogFilters);
              setRequestedPage(0);
              setModelsError("");
              setError("");
            }}
          >
            <option value="">Select a provider</option>
            <option value={ALL_PROVIDERS}>All providers</option>
            {catalog.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name || provider.id} ({provider.id})
              </option>
            ))}
          </select>
          {providerId && (
            <>
              <label className="block">
                Filter models
                <input
                  className={fieldClass}
                  value={filters.query}
                  onChange={(event) => filter({ query: event.target.value })}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label>
                  Model type
                  <select
                    aria-label="Model type"
                    className={fieldClass}
                    value={filters.type}
                    onChange={(event) => filter({ type: event.target.value })}
                  >
                    <option value="">All types</option>
                    {types.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Capability
                  <select
                    aria-label="Capability"
                    className={fieldClass}
                    value={filters.capability}
                    onChange={(event) =>
                      filter({ capability: event.target.value as CatalogFilters["capability"] })
                    }
                  >
                    <option value="">Any capability</option>
                    {Object.entries(catalogCapabilities).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Input modality
                  <select
                    aria-label="Input modality"
                    className={fieldClass}
                    value={filters.inputModality}
                    onChange={(event) => filter({ inputModality: event.target.value })}
                  >
                    <option value="">Any input</option>
                    {inputModalities.map((modality) => (
                      <option key={modality}>{modality}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Minimum context
                  <select
                    aria-label="Minimum context"
                    className={fieldClass}
                    value={filters.minContext}
                    onChange={(event) => filter({ minContext: Number(event.target.value) })}
                  >
                    <option value={0}>Any context</option>
                    {[8192, 32768, 128000, 200000, 1000000].map((size) => (
                      <option key={size} value={size}>
                        {size.toLocaleString()} tokens
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Sort by
                  <select
                    aria-label="Sort by"
                    className={fieldClass}
                    value={sort}
                    onChange={(event) => {
                      setModelsError("");
                      setSort(event.target.value as CatalogSort);
                      setRequestedPage(0);
                    }}
                  >
                    <option value="id">Model ID</option>
                    <option value="context">Context</option>
                    <option value="output">Output limit</option>
                    <option value="input-price">Input price</option>
                    <option value="output-price">Output price</option>
                  </select>
                </label>
                <label>
                  Sort direction
                  <select
                    aria-label="Sort direction"
                    className={fieldClass}
                    value={descending ? "desc" : "asc"}
                    onChange={(event) => {
                      setModelsError("");
                      setDescending(event.target.value === "desc");
                      setRequestedPage(0);
                    }}
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </label>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setModelsError("");
                  setFilters(emptyCatalogFilters);
                  setRequestedPage(0);
                }}
              >
                Clear filters
              </Button>
              {modelsError ? (
                <div role="alert">
                  <p>{modelsError}</p>
                  <Button
                    onClick={() => {
                      setModelsError("");
                      void load()
                        .then(() => setRetry((value) => value + 1))
                        .catch((cause) =>
                          setModelsError(
                            cause instanceof Error ? cause.message : "Cannot reload catalog."
                          )
                        );
                    }}
                  >
                    Retry models
                  </Button>
                </div>
              ) : !models ? (
                <p>Loading models…</p>
              ) : (
                <div className="overflow-x-auto">
                  <p className="my-3 text-sm text-text-muted">
                    {matchedCount} of {totalCount} models · Page {pagination.page + 1} of{" "}
                    {pagination.pageCount}
                  </p>
                  <table className="w-full text-left" aria-label="Model catalog">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Context</th>
                        <th>Output limit</th>
                        <th>Input / 1M</th>
                        <th>Output / 1M</th>
                        <th>Modalities</th>
                        <th>Capabilities</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagination.rows.map((model) => (
                        <tr key={JSON.stringify([model.provider_id, model.id])}>
                          <td>
                            {model.name || model.id}
                            <br />
                            <small>{model.id}</small>
                            {model.provider_id && (
                              <p className="text-sm text-text-muted">
                                {model.provider_name || model.provider_id} · {model.provider_id}
                              </p>
                            )}
                            <details className="my-2 max-w-xl">
                              <summary className="cursor-pointer text-sm text-primary">
                                Details for {model.id}
                              </summary>
                              <ModelDetails model={model} />
                            </details>
                          </td>
                          <td>{number(model.limit?.context)}</td>
                          <td>{number(model.limit?.output)}</td>
                          <td>{price(model.cost?.input)}</td>
                          <td>{price(model.cost?.output)}</td>
                          <td>
                            {model.modalities
                              ? `${model.modalities.input.join(", ")} → ${model.modalities.output.join(", ")}`
                              : "—"}
                          </td>
                          <td>
                            {Object.entries(catalogCapabilities)
                              .filter(
                                ([key]) => model[key as keyof typeof catalogCapabilities] === true
                              )
                              .map(([, label]) => label)
                              .join(", ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {matchedCount === 0 && <p>No matching models.</p>}
                  <div className="mt-4 flex gap-3">
                    <Button
                      variant="outline"
                      disabled={pagination.page === 0}
                      onClick={() => setRequestedPage(pagination.page - 1)}
                    >
                      Previous page
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pagination.page + 1 >= pagination.pageCount}
                      onClick={() => setRequestedPage(pagination.page + 1)}
                    >
                      Next page
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ModelDetails({ model }: { model: Model }) {
  const unknown = "Not specified";
  const number = (value?: number) => (value == null ? unknown : value.toLocaleString());
  const price = (value?: number) => (value == null ? unknown : `$${value}`);
  const entries: Array<[string, string]> = [
    ["Model type", model.type ?? unknown],
    ["Family", model.family ?? unknown],
    ["Canonical ID", model.canonical_model_id ?? unknown],
    ["Status", model.status ?? unknown],
    ["Knowledge cutoff", model.knowledge ?? unknown],
    ["Release date", model.release_date ?? unknown],
    ["Last updated", model.last_updated ?? unknown],
    ["Input token limit", number(model.limit?.input)],
    ["Cache read / 1M tokens", price(model.cost?.cache_read)],
    ["Cache write / 1M tokens", price(model.cost?.cache_write)],
    ["Reasoning / 1M tokens", price(model.cost?.reasoning)],
    ["Audio input / 1M tokens", price(model.cost?.input_audio)],
    ["Audio output / 1M tokens", price(model.cost?.output_audio)],
    ...Object.entries(catalogCapabilities).map(([id, label]): [string, string] => [
      label,
      model[id as keyof typeof catalogCapabilities] == null
        ? unknown
        : model[id as keyof typeof catalogCapabilities]
          ? "Yes"
          : "No",
    ]),
    [
      "Interleaved reasoning",
      model.interleaved == null
        ? unknown
        : typeof model.interleaved === "boolean"
          ? model.interleaved
            ? "Yes"
            : "No"
          : model.interleaved.field,
    ],
    [
      "Reasoning options",
      model.reasoning_options
        ?.map((option) =>
          option.type === "effort"
            ? `Effort: ${option.values.map((value) => value ?? "Default").join(", ")}`
            : option.type === "budget_tokens"
              ? `Budget: ${number(option.min)}–${number(option.max)} tokens`
              : "Toggle"
        )
        .join("; ") || unknown,
    ],
  ];
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 rounded border border-border p-3 text-sm">
      {entries.map(([label, value]) => (
        <div key={label} className="break-words">
          <dt className="text-text-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
