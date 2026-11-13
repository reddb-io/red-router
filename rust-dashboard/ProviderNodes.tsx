import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "./components";
import {
  listProviderNodes,
  saveProviderNode,
  deleteProviderNode,
  type ProviderNode,
  type ProviderNodeInput,
  type RustProvider,
} from "./api/browserClient";

const empty: ProviderNodeInput = {
  name: "",
  prefix: "",
  protocol: "openai",
  base_url: "",
  chat_path: "",
  models_path: null,
  apply_to_connections: false,
};
const field =
  "w-full rounded-lg border border-black/10 dark:border-white/10 bg-surface px-3 py-2 text-sm text-text";
const protocols = [
  ["openai", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic", "Anthropic Messages"],
  ["gemini", "Gemini"],
  ["openai-embeddings", "OpenAI Embeddings"],
  ["cohere-rerank", "Cohere Rerank"],
] as const;

export default function ProviderNodes({
  accounts,
  onNodes,
  onUpdated,
}: {
  accounts: RustProvider[];
  onNodes: (nodes: ProviderNode[]) => void;
  onUpdated: () => void;
}) {
  const [nodes, setNodes] = useState<ProviderNode[]>([]);
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState("");
  const [draft, setDraft] = useState<ProviderNodeInput>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const reload = useCallback(async () => {
    const rows = await listProviderNodes();
    setNodes(rows);
    onNodes(rows);
  }, [onNodes]);
  useEffect(() => {
    let active = true;
    listProviderNodes()
      .then((rows) => {
        if (active) {
          setNodes(rows);
          onNodes(rows);
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load provider definitions");
      });
    return () => {
      active = false;
    };
  }, [onNodes]);
  const linked = (nodeId: string) =>
    accounts.filter((account) => account.node_id === nodeId).length;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await saveProviderNode(id.trim(), {
        ...draft,
        name: draft.name.trim(),
        prefix: draft.prefix.trim(),
        base_url: draft.base_url.trim(),
        models_path: draft.models_path?.trim() || null,
      });
      setEditor(false);
      await reload();
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save provider definition");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (node: ProviderNode) => {
    if (!window.confirm(`Remove provider definition “${node.name}”?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteProviderNode(node.id);
      await reload();
      onUpdated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove provider definition");
    } finally {
      setBusy(false);
    }
  };
  const filtered = nodes.filter((node) =>
    `${node.name} ${node.prefix} ${node.base_url}`.toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <Card
      title="Custom provider definitions"
      subtitle="Share an API endpoint and model discovery settings across accounts. Each account keeps its own encrypted credential."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy}
          onClick={() => {
            setEditor(true);
            setEditing(false);
            setId("");
            setDraft({ ...empty });
            setError("");
          }}
        >
          Add provider definition
        </Button>
        <span className="text-xs text-text-muted">{nodes.length} definitions</span>
        {nodes.length > 5 && (
          <input
            className={field}
            aria-label="Filter provider definitions"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-feedback-danger-foreground">
          {error}
        </p>
      )}
      {editor && (
        <form
          className="mt-4 grid gap-3 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="text-xs text-text-muted">
            Definition ID
            <input
              className={field}
              value={id}
              disabled={editing || busy}
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={128}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label className="text-xs text-text-muted">
            Definition name
            <input
              className={field}
              value={draft.name}
              required
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="text-xs text-text-muted">
            Provider prefix
            <input
              className={field}
              value={draft.prefix}
              required
              maxLength={64}
              placeholder="company-gateway"
              onChange={(event) => setDraft({ ...draft, prefix: event.target.value })}
            />
          </label>
          <label className="text-xs text-text-muted">
            Definition protocol
            <select
              className={field}
              value={draft.protocol}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  protocol: event.target.value as ProviderNodeInput["protocol"],
                })
              }
            >
              {protocols.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted md:col-span-2">
            Base URL
            <input
              className={field}
              value={draft.base_url}
              type="url"
              required
              placeholder="https://gateway.example/v1"
              onChange={(event) => setDraft({ ...draft, base_url: event.target.value })}
            />
          </label>
          <label className="text-xs text-text-muted">
            Inference path
            <input
              className={field}
              value={draft.chat_path}
              maxLength={500}
              placeholder="Protocol default"
              onChange={(event) => setDraft({ ...draft, chat_path: event.target.value })}
            />
          </label>
          <label className="text-xs text-text-muted">
            Model discovery path
            <input
              className={field}
              value={draft.models_path ?? ""}
              maxLength={500}
              placeholder="/models"
              onChange={(event) => setDraft({ ...draft, models_path: event.target.value })}
            />
          </label>
          <p className="text-xs text-text-muted md:col-span-2">
            Paths are appended to the base URL. An account can override its model discovery path.
          </p>
          {editing && linked(id) > 0 && (
            <label className="flex items-start gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={draft.apply_to_connections ?? false}
                onChange={(event) =>
                  setDraft({ ...draft, apply_to_connections: event.target.checked })
                }
              />
              Apply endpoint, protocol or prefix changes to {linked(id)} linked accounts. Their
              existing credentials will be used at the new endpoint; connection-specific headers
              detach when the destination changes.
            </label>
          )}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save provider definition"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setEditor(false)}
            >
              Cancel definition edit
            </Button>
          </div>
        </form>
      )}
      <div className="mt-4 space-y-3">
        {filtered.slice(0, 100).map((node) => (
          <div
            key={node.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {node.name} <span className="font-normal text-text-muted">({node.prefix})</span>
              </p>
              <p className="break-all text-xs text-text-muted">{node.upstream_url}</p>
              <p className="text-xs text-text-muted">{linked(node.id)} linked accounts</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setEditor(true);
                  setEditing(true);
                  setId(node.id);
                  setDraft({
                    tenant_id: node.tenant_id,
                    name: node.name,
                    prefix: node.prefix,
                    protocol: node.protocol,
                    base_url: node.base_url,
                    chat_path: node.chat_path,
                    models_path: node.models_path,
                    apply_to_connections: false,
                  });
                  setError("");
                }}
              >
                Edit definition
              </Button>
              <Button
                variant="danger"
                disabled={busy || linked(node.id) > 0}
                title={
                  linked(node.id) ? "Unlink accounts before removing this definition" : undefined
                }
                onClick={() => void remove(node)}
              >
                Remove definition
              </Button>
            </div>
          </div>
        ))}
      </div>
      {filtered.length > 100 && (
        <p className="mt-2 text-xs text-text-muted">
          Showing the first 100 matches. Filter to find a definition.
        </p>
      )}
    </Card>
  );
}
