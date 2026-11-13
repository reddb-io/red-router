import { useEffect, useState } from "react";
import { Button, Card } from "./components";
import {
  listProviderModels,
  readProviderModel,
  saveProviderModel,
  deleteProviderModel,
  type ProviderModel,
  type ProviderModelPage,
} from "./api/providerModels";
import { catalogCapabilities, type CatalogModel } from "./catalogModels";

type Capability = keyof typeof catalogCapabilities;
const limits = [
  ["context", "Context window"],
  ["input", "Maximum input tokens"],
  ["output", "Maximum output tokens"],
] as const;
const prices = [
  ["input", "Input price"],
  ["output", "Output price"],
  ["cache_read", "Cache read price"],
  ["cache_write", "Cache write price"],
  ["reasoning", "Reasoning price"],
  ["input_audio", "Audio input price"],
  ["output_audio", "Audio output price"],
] as const;
type Draft = {
  tenant: string;
  provider: string;
  id: string;
  name: string;
  type: string;
  hidden: boolean;
  limits: Record<(typeof limits)[number][0], string>;
  prices: Record<(typeof prices)[number][0], string>;
  capabilities: Partial<Record<Capability, string>>;
  inputModalities: string;
  outputModalities: string;
};
const empty = (): Draft => ({
  tenant: "",
  provider: "",
  id: "",
  name: "",
  type: "",
  hidden: false,
  limits: { context: "", input: "", output: "" },
  prices: {
    input: "",
    output: "",
    cache_read: "",
    cache_write: "",
    reasoning: "",
    input_audio: "",
    output_audio: "",
  },
  capabilities: {},
  inputModalities: "",
  outputModalities: "",
});
const field = "rounded border border-border bg-surface px-3 py-2 text-sm text-text";
const label = "flex flex-col gap-1 text-sm";
function numeric<T extends string>(
  values: Record<T, string>,
  integer: boolean
): Partial<Record<T, number>> | undefined {
  const result: Partial<Record<T, number>> = {};
  for (const [key, raw] of Object.entries(values) as Array<[T, string]>) {
    if (!raw.trim()) continue;
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      value < (integer ? 1 : 0) ||
      value > 1_000_000_000 ||
      (integer && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        integer
          ? "Token limits must be positive whole numbers up to 1000000000"
          : "Prices must be nonnegative numbers up to 1000000000"
      );
    }
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
function editable(model: ProviderModel): Draft {
  const metadata = model.metadata;
  return {
    ...empty(),
    tenant: model.tenant_id,
    provider: model.provider,
    id: metadata.id,
    name: metadata.name ?? "",
    type: metadata.type ?? "",
    hidden: model.hidden ?? false,
    limits: Object.fromEntries(
      limits.map(([key]) => [key, metadata.limit?.[key] == null ? "" : String(metadata.limit[key])])
    ) as Draft["limits"],
    prices: Object.fromEntries(
      prices.map(([key]) => [key, metadata.cost?.[key] == null ? "" : String(metadata.cost[key])])
    ) as Draft["prices"],
    capabilities: Object.fromEntries(
      Object.keys(catalogCapabilities).map((key) => [
        key,
        metadata[key as Capability] == null ? "" : String(metadata[key as Capability]),
      ])
    ),
    inputModalities: metadata.modalities?.input.join(", ") ?? "",
    outputModalities: metadata.modalities?.output.join(", ") ?? "",
  };
}
export default function CustomModels({
  providers = [],
}: {
  providers?: Array<{ id: string; name: string | null }>;
}) {
  const [page, setPage] = useState<ProviderModelPage | null>(null);
  const [filter, setFilter] = useState({ tenant: "", provider: "", offset: 0 });
  const [filterDraft, setFilterDraft] = useState({ tenant: "", provider: "" });
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState<ProviderModel | null>(null);
  const [editor, setEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishedRequest, setFinishedRequest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([filter, revision]);
  const loading = finishedRequest !== requestKey;
  useEffect(() => {
    const controller = new AbortController();
    listProviderModels(filter, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setPage(value);
          setError("");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load custom models");
      })
      .finally(() => {
        if (!controller.signal.aborted) setFinishedRequest(requestKey);
      });
    return () => controller.abort();
  }, [filter, revision, requestKey]);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setError("");
    setMessage("");
    try {
      if (!draft.provider.trim() || !draft.id.trim())
        throw new Error("Provider and model ID are required");
      const metadata: CatalogModel = {
        ...editing?.metadata,
        id: draft.id.trim(),
        name: draft.name.trim() || undefined,
        type: draft.type.trim() || undefined,
        limit: numeric(draft.limits, true),
        cost: numeric(draft.prices, false),
      };
      for (const key of Object.keys(catalogCapabilities) as Capability[]) {
        metadata[key] =
          draft.capabilities[key] === "" || draft.capabilities[key] == null
            ? undefined
            : draft.capabilities[key] === "true";
      }
      const modalities = (value: string) => [
        ...new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        ),
      ];
      metadata.modalities =
        draft.inputModalities.trim() || draft.outputModalities.trim()
          ? { input: modalities(draft.inputModalities), output: modalities(draft.outputModalities) }
          : undefined;
      setBusy(true);
      await saveProviderModel(
        {
          provider: draft.provider.trim(),
          tenant_id: draft.tenant.trim() || undefined,
          metadata,
          hidden: draft.hidden,
          visibility_only: false,
          revision: editing?.revision,
        },
        editing?.id
      );
      setEditor(false);
      setEditing(null);
      setDraft(empty());
      setRevision((value) => value + 1);
      setMessage("Custom model saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save custom model");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (model: ProviderModel) => {
    if (
      !window.confirm(
        `Remove custom settings for “${model.metadata.name || model.metadata.id}”? Catalog defaults will apply where available.`
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await deleteProviderModel(model);
      setRevision((value) => value + 1);
      setMessage("Custom model removed.");
      if (editing?.id === model.id) setEditor(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove custom model");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Custom models and overrides"
      subtitle="Manage model names, limits and token prices for an organization. Routing and API-key permissions are configured separately."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            setEditor(true);
            setEditing(null);
            setDraft(empty());
            setError("");
            setMessage("");
          }}
        >
          Add custom model
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          loading={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh custom models
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
      {editor && (
        <div className="mt-4 rounded border border-border p-4">
          <h3 className="font-semibold">{editing ? "Edit custom model" : "New custom model"}</h3>
          <p className="my-2 text-sm text-text-muted">
            Blank fields inherit catalog defaults when available. Prices are USD per million tokens.
            Changes apply to new requests; recorded charges retain their original prices.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className={label}>
              Model organization ID
              <input
                className={field}
                value={draft.tenant}
                disabled={busy || !!editing}
                placeholder="Current organization"
                onChange={(event) => change("tenant", event.target.value)}
              />
            </label>
            <label className={label}>
              Model provider
              <input
                className={field}
                list="custom-model-providers"
                value={draft.provider}
                disabled={busy || !!editing}
                onChange={(event) => change("provider", event.target.value)}
              />
            </label>
            <datalist id="custom-model-providers">
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name || provider.id}
                </option>
              ))}
            </datalist>
            <label className={label}>
              Custom model ID
              <input
                className={field}
                value={draft.id}
                disabled={busy || !!editing}
                maxLength={256}
                onChange={(event) => change("id", event.target.value)}
              />
            </label>
            <label className={label}>
              Model display name
              <input
                className={field}
                value={draft.name}
                disabled={busy}
                maxLength={256}
                onChange={(event) => change("name", event.target.value)}
              />
            </label>
            <label className={label}>
              Model type
              <input
                className={field}
                value={draft.type}
                disabled={busy}
                placeholder="chat, embedding, rerank…"
                onChange={(event) => change("type", event.target.value)}
              />
            </label>
            {limits.map(([key, title]) => (
              <label key={key} className={label}>
                {title}
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={1_000_000_000}
                  step={1}
                  value={draft.limits[key]}
                  disabled={busy}
                  placeholder="Inherit"
                  onChange={(event) =>
                    change("limits", { ...draft.limits, [key]: event.target.value })
                  }
                />
              </label>
            ))}
            {prices.map(([key, title]) => (
              <label key={key} className={label}>
                {title} (USD / 1M tokens)
                <input
                  className={field}
                  type="number"
                  min={0}
                  max={1_000_000_000}
                  step="any"
                  value={draft.prices[key]}
                  disabled={busy}
                  placeholder="Inherit"
                  onChange={(event) =>
                    change("prices", { ...draft.prices, [key]: event.target.value })
                  }
                />
              </label>
            ))}
            {(Object.entries(catalogCapabilities) as Array<[Capability, string]>).map(
              ([key, title]) => (
                <label key={key} className={label}>
                  {title} support
                  <select
                    className={field}
                    value={draft.capabilities[key] ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      change("capabilities", { ...draft.capabilities, [key]: event.target.value })
                    }
                  >
                    <option value="">Inherit</option>
                    <option value="true">Supported</option>
                    <option value="false">Not supported</option>
                  </select>
                </label>
              )
            )}
            <label className={label}>
              Input modalities
              <input
                className={field}
                value={draft.inputModalities}
                disabled={busy}
                placeholder="text, image"
                onChange={(event) => change("inputModalities", event.target.value)}
              />
            </label>
            <label className={label}>
              Output modalities
              <input
                className={field}
                value={draft.outputModalities}
                disabled={busy}
                placeholder="text"
                onChange={(event) => change("outputModalities", event.target.value)}
              />
            </label>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.hidden}
              disabled={busy}
              onChange={(event) => change("hidden", event.target.checked)}
            />
            <span>
              Hide from client model lists
              <span className="block text-text-muted">
                Migrated activation rules may also block requests for hidden models.
              </span>
            </span>
          </label>
          <div className="mt-4 flex gap-2">
            <Button loading={busy} onClick={() => void save()}>
              Save custom model
            </Button>
            {editing && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const latest = await readProviderModel(editing.id);
                    setEditing(latest);
                    setDraft(editable(latest));
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not reload model");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Discard edits and reload
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => setEditor(false)}>
              Cancel model edit
            </Button>
          </div>
        </div>
      )}
      <div className="my-4 flex flex-wrap items-end gap-2">
        <label className={label}>
          Filter model organization
          <input
            className={field}
            value={filterDraft.tenant}
            disabled={busy}
            onChange={(event) =>
              setFilterDraft((current) => ({ ...current, tenant: event.target.value }))
            }
          />
        </label>
        <label className={label}>
          Filter model provider
          <input
            className={field}
            value={filterDraft.provider}
            disabled={busy}
            onChange={(event) =>
              setFilterDraft((current) => ({ ...current, provider: event.target.value }))
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            setFilter({
              ...filterDraft,
              tenant: filterDraft.tenant.trim(),
              provider: filterDraft.provider.trim(),
              offset: 0,
            })
          }
        >
          Filter custom models
        </Button>
      </div>
      {page && (
        <>
          <p className="mb-2 text-sm text-text-muted">{page.total} custom model settings</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {[
                    "Model",
                    "Provider",
                    "Organization",
                    "Context",
                    "Input / output price",
                    "Actions",
                  ].map((title) => (
                    <th key={title} className="border-b border-border p-2">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.models.map((model) => (
                  <tr key={model.id}>
                    <td className="p-2">
                      <strong>{model.effective.name || model.metadata.id}</strong>
                      {model.hidden && <span className="ml-2 text-xs text-text-muted">Hidden</span>}
                      <div className="font-mono text-xs">{model.metadata.id}</div>
                    </td>
                    <td className="p-2">{model.provider}</td>
                    <td className="p-2">{model.tenant_id}</td>
                    <td className="p-2">
                      {model.effective.limit?.context?.toLocaleString() ?? "Unknown"}
                    </td>
                    <td className="p-2">
                      {model.effective.cost?.input ?? "Unknown"} /{" "}
                      {model.effective.cost?.output ?? "Unknown"} USD / 1M
                    </td>
                    <td className="p-2">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setEditing(model);
                            setDraft(editable(model));
                            setEditor(true);
                            setError("");
                            setMessage("");
                          }}
                        >
                          Edit model
                        </Button>
                        <Button variant="danger" disabled={busy} onClick={() => void remove(model)}>
                          Remove model
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total === 0 && (
            <p className="py-3 text-sm text-text-muted">No custom models match these filters.</p>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              disabled={busy || loading || filter.offset === 0}
              onClick={() =>
                setFilter((current) => ({ ...current, offset: Math.max(0, current.offset - 50) }))
              }
            >
              Previous custom models
            </Button>
            <Button
              variant="outline"
              disabled={busy || loading || page.offset + page.models.length >= page.total}
              onClick={() => setFilter((current) => ({ ...current, offset: current.offset + 50 }))}
            >
              Next custom models
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
