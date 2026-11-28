import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";
import RouteExplanation from "./RouteExplanation";

type Usage = {
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_creation: number;
  tokens_reasoning: number;
  amount_usd: number | null;
};
type Entry = {
  id: string;
  created_at_unix_ms: number;
  request_id: string;
  attempt: number;
  tenant_id: string;
  key_id: string;
  protocol: string;
  requested_model: string;
  model: string;
  provider: string;
  provider_id: string;
  status: number;
  error: string | null;
  duration_ms: number;
  ttft_ms: number | null;
  stream: boolean;
  usage: Usage | null;
};
type Page = { requests: Entry[]; next_cursor: string | null };
type Filters = { keyId: string; requestId: string; outcome: "" | "ok" | "error" };

function isPage(value: unknown): value is Page {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return (
    Array.isArray(page.requests) &&
    (page.next_cursor === null || typeof page.next_cursor === "string")
  );
}

function usageText(usage: Usage | null): string {
  if (!usage) return "—";
  const reasoning = usage.tokens_reasoning ? ` / ${usage.tokens_reasoning.toLocaleString()} reasoning` : "";
  return `${usage.tokens_input.toLocaleString()} in / ${usage.tokens_output.toLocaleString()} out${reasoning}`;
}

function costText(usage: Usage | null): string {
  if (!usage) return "—";
  return usage.amount_usd === null ? "Unpriced" : `$${usage.amount_usd.toFixed(6)}`;
}

export default function RequestLog() {
  const [draft, setDraft] = useState<Filters>({ keyId: "", requestId: "", outcome: "" });
  const [selection, setSelection] = useState<{ filters: Filters; cursor: string | null }>({
    filters: { keyId: "", requestId: "", outcome: "" },
    cursor: null,
  });
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [explaining, setExplaining] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "50" });
    const { keyId, requestId, outcome } = selection.filters;
    if (keyId) query.set("key_id", keyId);
    if (requestId) query.set("request_id", requestId);
    if (outcome) query.set("outcome", outcome);
    if (selection.cursor) query.set("cursor", selection.cursor);
    rustAdminFetch(`/api/admin/request-log?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 501) throw new Error("The request log needs SQLite storage.");
        if (!response.ok) throw new Error(`Request log unavailable (${response.status})`);
        const data: unknown = await response.json();
        if (!isPage(data)) throw new Error("Invalid request log");
        setPage(data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Request log unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selection, refresh]);

  const navigate = (next: { filters: Filters; cursor: string | null }) => {
    setLoading(true);
    setError("");
    setSelection(next);
  };

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Request log</h1>
      <p>
        Every upstream attempt of the last 7 days, newest first · UTC. Attempts of one request share
        a request ID, so a fallback reads as consecutive attempts.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({
            filters: {
              keyId: draft.keyId.trim(),
              requestId: draft.requestId.trim(),
              outcome: draft.outcome,
            },
            cursor: null,
          });
        }}
      >
        <label>
          API key ID{" "}
          <input
            className="rounded border border-border bg-surface px-3 py-2"
            value={draft.keyId}
            onChange={(event) => setDraft({ ...draft, keyId: event.target.value })}
          />
        </label>
        <label>
          Request ID{" "}
          <input
            className="rounded border border-border bg-surface px-3 py-2"
            value={draft.requestId}
            onChange={(event) => setDraft({ ...draft, requestId: event.target.value })}
          />
        </label>
        <label>
          Outcome{" "}
          <select
            className="rounded border border-border bg-surface px-3 py-2"
            value={draft.outcome}
            onChange={(event) =>
              setDraft({ ...draft, outcome: event.target.value as Filters["outcome"] })
            }
          >
            <option value="">All</option>
            <option value="ok">Succeeded</option>
            <option value="error">Failed</option>
          </select>
        </label>
        <button className="rounded border border-border px-3 py-2" type="submit">
          Filter
        </button>
        <button
          className="rounded border border-border px-3 py-2"
          type="button"
          onClick={() => {
            setLoading(true);
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </form>
      {explaining && <RouteExplanation id={explaining} onClose={() => setExplaining(null)} />}
      {loading && <p>Loading requests…</p>}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!loading && !error && page && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Request / attempt</th>
                  <th>Model</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Usage</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {page.requests.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.created_at_unix_ms).toISOString()}</td>
                    <td>
                      <button
                        type="button"
                        className="underline"
                        title="Show every attempt of this request"
                        onClick={() => {
                          const filters = { keyId: "", requestId: entry.request_id, outcome: "" as const };
                          setDraft(filters);
                          navigate({ filters, cursor: null });
                        }}
                      >
                        {entry.request_id}
                      </button>{" "}
                      #{entry.attempt}{" "}
                      <button
                        type="button"
                        className="underline"
                        title="Explain why this request went where it went"
                        onClick={() => setExplaining(entry.id)}
                      >
                        Explain
                      </button>
                    </td>
                    <td>
                      {entry.requested_model === entry.model
                        ? entry.model
                        : `${entry.requested_model} → ${entry.model}`}
                      <br />
                      <small>
                        {entry.protocol}
                        {entry.stream ? " · stream" : ""}
                      </small>
                    </td>
                    <td>
                      {entry.provider_id || "—"}
                      {entry.provider && <small> ({entry.provider})</small>}
                    </td>
                    <td>
                      {entry.status}
                      {entry.error && <small> {entry.error}</small>}
                    </td>
                    <td>
                      {entry.duration_ms.toLocaleString()} ms
                      {entry.ttft_ms !== null && (
                        <>
                          <br />
                          <small>first chunk {entry.ttft_ms.toLocaleString()} ms</small>
                        </>
                      )}
                    </td>
                    <td>{usageText(entry.usage)}</td>
                    <td>{costText(entry.usage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.requests.length === 0 && <p>No requests in this period.</p>}
          <div className="flex gap-4">
            {selection.cursor && (
              <button type="button" onClick={() => navigate({ ...selection, cursor: null })}>
                First page
              </button>
            )}
            {page.next_cursor && (
              <button
                type="button"
                onClick={() => navigate({ ...selection, cursor: page.next_cursor })}
              >
                Next page
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
