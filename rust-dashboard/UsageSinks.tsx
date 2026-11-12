import { useCallback, useEffect, useState } from "react";
import { listRustClientKeys, rustUsageSinkFetch, type RustClientKey } from "./api/browserClient";
import type { TransportDescriptor, UsageSink } from "./types/usageSinks";

type Draft = {
  id: string | null;
  name: string;
  type: string;
  tenantId: string;
  enabled: boolean;
  mode: "instant" | "window";
  windowSec: number;
  keyIds: string[];
  selectedKeys: boolean;
  config: Record<string, string>;
};

const inputClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

type SinkResponse = {
  sinks?: UsageSink[];
  types?: TransportDescriptor[];
  windowSizesSec?: number[];
  valid?: boolean;
  error?: string | { message?: string };
};

async function json(path: string, init?: RequestInit): Promise<SinkResponse> {
  const response = await rustUsageSinkFetch(path, init);
  const value: SinkResponse = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = value?.error;
    throw new Error(
      typeof error === "string" ? error : error?.message || `Request failed (${response.status})`
    );
  }
  return value;
}

function newDraft(types: TransportDescriptor[], windowSizes: number[], sink?: UsageSink): Draft {
  const type = sink?.type ?? types[0]?.type ?? "";
  const descriptor = types.find((item) => item.type === type);
  return {
    id: sink?.id ?? null,
    name: sink?.name ?? "",
    type,
    tenantId: "",
    enabled: sink?.enabled ?? true,
    mode: sink?.mode ?? "instant",
    windowSec: sink?.windowSec ?? windowSizes[1] ?? windowSizes[0] ?? 900,
    keyIds: sink?.apiKeyIds ?? [],
    selectedKeys: Boolean(sink?.apiKeyIds.length),
    config: Object.fromEntries(
      (descriptor?.fields ?? []).map((field) => [
        field.key,
        field.secret ? "" : String(sink?.config?.[field.key] ?? ""),
      ])
    ),
  };
}

export default function UsageSinks() {
  const [types, setTypes] = useState<TransportDescriptor[]>([]);
  const [windowSizes, setWindowSizes] = useState<number[]>([]);
  const [sinks, setSinks] = useState<UsageSink[]>([]);
  const [keys, setKeys] = useState<RustClientKey[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const [sinkData, typeData, clientKeys] = await Promise.all([
      json("/api/usage-sinks"),
      json("/api/usage-sinks/types"),
      listRustClientKeys(),
    ]);
    if (!Array.isArray(sinkData.sinks) || !Array.isArray(typeData.types))
      throw new Error("Invalid usage export response");
    setSinks(sinkData.sinks);
    setTypes(typeData.types);
    setWindowSizes(typeData.windowSizesSec ?? []);
    setKeys(clientKeys);
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(load)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Cannot load usage exports")
      )
      .finally(() => setLoading(false));
  }, [load]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const descriptor = types.find((item) => item.type === draft?.type);
  const save = () => {
    if (!draft || !descriptor) return;
    void perform(async () => {
      if (draft.selectedKeys && draft.keyIds.length === 0)
        throw new Error("Select at least one API key.");
      const config: Record<string, string> = {};
      for (const field of descriptor.fields) {
        const value = draft.config[field.key] ?? "";
        if (value.trim()) config[field.key] = value;
        else if (field.secret && draft.id) config[field.key] = "__stored__";
      }
      const payload = {
        name: draft.name.trim(),
        mode: draft.mode,
        ...(draft.mode === "window" ? { windowSec: draft.windowSec } : {}),
        enabled: draft.enabled,
        apiKeyIds: draft.selectedKeys ? draft.keyIds : [],
        config,
        ...(draft.id
          ? {}
          : {
              type: draft.type,
              ...(draft.tenantId.trim() ? { tenantId: draft.tenantId.trim() } : {}),
            }),
      };
      await json(
        draft.id ? `/api/usage-sinks/${encodeURIComponent(draft.id)}` : "/api/usage-sinks",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      setDraft(null);
      await load();
      setNotice("Usage destination saved.");
    });
  };

  const update = (
    sink: UsageSink,
    method: "DELETE" | "PATCH" | "POST",
    body?: unknown,
    suffix = ""
  ) => {
    if (method === "DELETE" && !window.confirm(`Delete usage destination “${sink.name}”?`)) return;
    void perform(async () => {
      const result = await json(`/api/usage-sinks/${encodeURIComponent(sink.id)}${suffix}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (suffix && result.valid !== true)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : result.error?.message || "Destination test failed"
        );
      await load();
      setNotice(suffix ? "Destination test succeeded." : "Usage destination updated.");
    });
  };

  if (loading) return <div className="p-6">Loading usage destinations…</div>;
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Usage destinations</h1>
        <button
          type="button"
          className="rounded bg-primary px-4 py-2 text-white"
          disabled={busy || types.length === 0}
          onClick={() => setDraft(newDraft(types, windowSizes))}
        >
          Add destination
        </button>
      </div>
      <p>Export attributed usage to BigQuery, a signed webhook, RedDB, or Amazon SQS.</p>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {draft && (
        <form
          className="flex flex-col gap-4 rounded border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <h2 className="text-lg font-semibold">
            {draft.id ? "Edit destination" : "New destination"}
          </h2>
          <label>
            Name
            <input
              className={inputClass}
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            Destination type
            <select
              className={inputClass}
              value={draft.type}
              disabled={Boolean(draft.id)}
              onChange={(event) => {
                const nextType = event.target.value;
                const nextDescriptor = types.find((item) => item.type === nextType);
                setDraft({
                  ...draft,
                  type: nextType,
                  mode: nextDescriptor?.modes?.includes(draft.mode) ? draft.mode : "instant",
                  config: {},
                });
              }}
            >
              {types.map((type) => (
                <option key={type.type} value={type.type}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          {!draft.id && (
            <label>
              Tenant ID (optional)
              <input
                className={inputClass}
                value={draft.tenantId}
                onChange={(event) => setDraft({ ...draft, tenantId: event.target.value })}
              />
            </label>
          )}
          {(descriptor?.modes?.length ?? 0) > 1 && (
            <label>
              Delivery mode
              <select
                className={inputClass}
                value={draft.mode}
                onChange={(event) =>
                  setDraft({ ...draft, mode: event.target.value as "instant" | "window" })
                }
              >
                <option value="instant">Each usage event</option>
                <option value="window">Aggregated windows</option>
              </select>
            </label>
          )}
          {draft.mode === "window" && (
            <label>
              Window size
              <select
                className={inputClass}
                value={draft.windowSec}
                onChange={(event) =>
                  setDraft({ ...draft, windowSec: Number(event.target.value) })
                }
              >
                {windowSizes.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds < 3600 ? `${seconds / 60} minutes` : "1 hour"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {descriptor?.fields.map((field) => (
            <label key={field.key}>
              {field.labelFallback}
              {field.type === "textarea" ? (
                <textarea
                  className={inputClass}
                  autoComplete="off"
                  required={field.required && !(draft.id && field.secret)}
                  placeholder={
                    draft.id && field.secret
                      ? "Leave blank to keep existing credential"
                      : field.placeholder
                  }
                  value={draft.config[field.key] ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      config: { ...draft.config, [field.key]: event.target.value },
                    })
                  }
                />
              ) : (
                <input
                  className={inputClass}
                  type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
                  autoComplete="off"
                  required={field.required && !(draft.id && field.secret)}
                  placeholder={
                    draft.id && field.secret
                      ? "Leave blank to keep existing credential"
                      : field.placeholder
                  }
                  value={draft.config[field.key] ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      config: { ...draft.config, [field.key]: event.target.value },
                    })
                  }
                />
              )}
              {field.helpFallback && (
                <span className="block text-sm text-text-muted">{field.helpFallback}</span>
              )}
            </label>
          ))}
          <fieldset>
            <legend>API keys</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.selectedKeys}
                onChange={(event) => setDraft({ ...draft, selectedKeys: event.target.checked })}
              />{" "}
              Limit to selected keys
            </label>
            {draft.selectedKeys && (
              <div>
                {keys.map((key) => (
                  <label key={key.id} className="block">
                    <input
                      type="checkbox"
                      checked={draft.keyIds.includes(key.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          keyIds: event.target.checked
                            ? [...draft.keyIds, key.id]
                            : draft.keyIds.filter((id) => id !== key.id),
                        })
                      }
                    />{" "}
                    {key.label} ({key.id})
                  </label>
                ))}
                {draft.keyIds
                  .filter((id) => !keys.some((key) => key.id === id))
                  .map((id) => (
                    <label key={id} className="block">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setDraft({
                            ...draft,
                            keyIds: draft.keyIds.filter((keyId) => keyId !== id),
                          })
                        }
                      />{" "}
                      Unavailable key ({id})
                    </label>
                  ))}
              </div>
            )}
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />{" "}
            Enabled
          </label>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy || !draft.name.trim()}
              className="rounded bg-primary px-4 py-2 text-white"
            >
              Save destination
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {sinks.length === 0 && !error && <p>No usage destinations configured.</p>}
      {sinks.map((sink) => (
        <article key={sink.id} className="flex flex-col gap-2 rounded border border-border p-4">
          <h2 className="font-semibold">{sink.name}</h2>
          <p>
            {sink.typeLabel} · {sink.enabled ? "Enabled" : "Paused"} ·{" "}
            {sink.mode === "window"
              ? `${(sink.windowSec ?? 0) / 60} minute windows`
              : "Each event"}
          </p>
          <p>{sink.summary}</p>
          <div className="flex flex-wrap gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(newDraft(types, windowSizes, sink))}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => update(sink, "PATCH", { enabled: !sink.enabled })}
            >
              {sink.enabled ? "Pause" : "Enable"}
            </button>
            <button type="button" disabled={busy} onClick={() => update(sink, "POST", {}, "/test")}>
              Send test
            </button>
            <button type="button" disabled={busy} onClick={() => update(sink, "DELETE")}>
              Delete
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
