import { useEffect, useState } from "react";
import { Button, Card } from "./components";
import {
  listModelAliases,
  readModelAlias,
  saveModelAlias,
  deleteModelAlias,
  type ModelAlias,
  type AliasPage,
  type AliasInput,
} from "./api/modelAliases";
const protocols = [
  ["openai", "OpenAI chat"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic", "Anthropic Messages"],
  ["gemini", "Gemini"],
  ["openai-to-anthropic", "OpenAI chat → Anthropic"],
  ["openai-to-antigravity", "OpenAI chat → Antigravity"],
  ["openai-embeddings", "Embeddings"],
  ["cohere-rerank", "Rerank"],
];
const empty = (): AliasInput => ({
  tenant_id: "",
  alias: "",
  provider: "",
  model: "",
  protocol: "openai",
  enabled: true,
});
const field = "rounded border border-border bg-surface px-3 py-2 text-sm text-text";
export default function ModelAliases() {
  const [page, setPage] = useState<AliasPage | null>(null);
  const [filter, setFilter] = useState({ tenant: "", provider: "", offset: 0 });
  const [filterDraft, setFilterDraft] = useState({ tenant: "", provider: "" });
  const [draft, setDraft] = useState<AliasInput>(empty);
  const [editing, setEditing] = useState<ModelAlias | null>(null);
  const [editor, setEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [finished, setFinished] = useState<string | null>(null);
  const requestKey = JSON.stringify([filter, revision]);
  const loading = finished !== requestKey;
  useEffect(() => {
    const controller = new AbortController();
    listModelAliases(filter, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setPage(value);
          setError("");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load aliases");
      })
      .finally(() => {
        if (!controller.signal.aborted) setFinished(requestKey);
      });
    return () => controller.abort();
  }, [filter, revision, requestKey]);
  function edit(row: ModelAlias) {
    setEditing(row);
    setDraft({
      tenant_id: row.tenant_id,
      alias: row.alias,
      provider: row.provider,
      model: row.model,
      protocol: row.protocol,
      enabled: row.enabled,
      revision: row.revision,
    });
    setEditor(true);
    setError("");
    setNotice("");
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!draft.alias.trim() || !draft.provider.trim() || !draft.model.trim())
        throw new Error("Alias, provider and upstream model are required");
      await saveModelAlias(
        {
          ...draft,
          tenant_id: draft.tenant_id?.trim() || undefined,
          alias: draft.alias.trim(),
          provider: draft.provider.trim(),
          model: draft.model.trim(),
        },
        editing?.id
      );
      setEditor(false);
      setEditing(null);
      setDraft(empty());
      setRevision((value) => value + 1);
      setNotice("Model alias saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save alias");
    } finally {
      setBusy(false);
    }
  }
  async function remove(row: ModelAlias) {
    if (
      !window.confirm(
        `Remove the model alias “${row.alias}”? Clients using this name will no longer reach its configured model.`
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await deleteModelAlias(row);
      setRevision((value) => value + 1);
      setNotice("Model alias removed.");
      if (editing?.id === row.id) setEditor(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove alias");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Model aliases"
      subtitle="Publish a stable model name for clients and map it to a provider’s upstream model."
    >
      <p className="mb-3 text-sm text-text-muted">
        Aliases belong to an organization and use its enabled provider connections. API-key
        permissions and quotas still apply. Once aliases are configured, clients must use a
        configured alias or combo; unknown names are rejected.
      </p>
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            setEditing(null);
            setDraft(empty());
            setEditor(true);
            setError("");
            setNotice("");
          }}
        >
          Add model alias
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          loading={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh aliases
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      {editor && (
        <div className="mt-4 rounded border border-border p-4">
          <h3 className="mb-3 font-semibold">{editing ? "Edit model alias" : "New model alias"}</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {(
              [
                ["tenant_id", "Alias organization ID"],
                ["alias", "Client model name"],
                ["provider", "Alias provider"],
                ["model", "Upstream model ID"],
              ] as const
            ).map(([key, title]) => (
              <label key={key} className="flex flex-col gap-1 text-sm">
                {title}
                <input
                  className={field}
                  value={draft[key] ?? ""}
                  disabled={busy || (!!editing && (key === "tenant_id" || key === "alias"))}
                  placeholder={key === "tenant_id" ? "Current organization" : undefined}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, [key]: event.target.value }))
                  }
                />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-sm">
              Alias protocol
              <select
                className={field}
                value={draft.protocol}
                disabled={busy}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, protocol: event.target.value }))
                }
              >
                {protocols.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={busy}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, enabled: event.target.checked }))
                }
              />
              Alias enabled
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => void save()}>
              Save model alias
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setEditor(false)}>
              Cancel alias edit
            </Button>
            {editing && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void readModelAlias(editing.id)
                    .then(edit)
                    .catch((cause) =>
                      setError(cause instanceof Error ? cause.message : "Could not reload alias")
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Discard alias edits and reload
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="my-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Filter alias organization
          <input
            className={field}
            value={filterDraft.tenant}
            onChange={(event) =>
              setFilterDraft((value) => ({ ...value, tenant: event.target.value }))
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Filter alias provider
          <input
            className={field}
            value={filterDraft.provider}
            onChange={(event) =>
              setFilterDraft((value) => ({ ...value, provider: event.target.value }))
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            setFilter({
              tenant: filterDraft.tenant.trim(),
              provider: filterDraft.provider.trim(),
              offset: 0,
            })
          }
        >
          Filter aliases
        </Button>
      </div>
      {page && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {[
                    "Client name",
                    "Organization",
                    "Provider",
                    "Upstream model",
                    "Protocol",
                    "State",
                    "Actions",
                  ].map((title) => (
                    <th className="p-2" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.aliases.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="p-2 font-mono">{row.alias}</td>
                    <td className="p-2">{row.tenant_id}</td>
                    <td className="p-2">{row.provider}</td>
                    <td className="p-2 font-mono">{row.model}</td>
                    <td className="p-2">
                      {protocols.find(([id]) => id === row.protocol)?.[1] ?? row.protocol}
                    </td>
                    <td className="p-2">{row.enabled ? "Enabled" : "Disabled"}</td>
                    <td className="p-2">
                      <div className="flex gap-2">
                        <Button variant="outline" disabled={busy} onClick={() => edit(row)}>
                          Edit alias
                        </Button>
                        <Button variant="outline" disabled={busy} onClick={() => void remove(row)}>
                          Remove alias
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.aliases.length === 0 && (
            <p className="py-3 text-sm text-text-muted">No model aliases match these filters.</p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              disabled={busy || loading || filter.offset === 0}
              onClick={() =>
                setFilter((value) => ({ ...value, offset: Math.max(0, value.offset - 50) }))
              }
            >
              Previous aliases
            </Button>
            <span className="text-sm">{page.total} aliases</span>
            <Button
              variant="outline"
              disabled={busy || loading || page.offset + page.aliases.length >= page.total}
              onClick={() => setFilter((value) => ({ ...value, offset: value.offset + 50 }))}
            >
              Next aliases
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
