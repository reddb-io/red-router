import { useCallback, useEffect, useState, type FormEvent } from "react";
import { listRustAuditEvents, type RustAuditEvent, type RustAuditQuery } from "./api/browserClient";

const PAGE_SIZE = 50;
const fieldClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

type Filters = {
  action: string;
  actor: string;
  target: string;
  resourceType: string;
  status: string;
  requestId: string;
};

const emptyFilters: Filters = {
  action: "",
  actor: "",
  target: "",
  resourceType: "",
  status: "",
  requestId: "",
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AuditLog() {
  const [events, setEvents] = useState<RustAuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [selected, setSelected] = useState<RustAuditEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);

  const fetchPage = useCallback(async () => {
    const query: RustAuditQuery = {
      limit: PAGE_SIZE,
      offset,
      action: applied.action.trim() || undefined,
      actor: applied.actor.trim() || undefined,
      target: applied.target.trim() || undefined,
      resourceType: applied.resourceType.trim() || undefined,
      status: applied.status.trim() || undefined,
      requestId: applied.requestId.trim() || undefined,
    };
    return listRustAuditEvents(query);
  }, [applied, offset]);

  useEffect(() => {
    let active = true;
    void fetchPage()
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setTotal(page.total);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load the audit log.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchPage, refreshVersion]);

  function refresh() {
    setLoading(true);
    setError("");
    setRefreshVersion((current) => current + 1);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setOffset(0);
    setApplied(filters);
    setRefreshVersion((current) => current + 1);
  }

  function clearFilters() {
    setLoading(true);
    setError("");
    setFilters(emptyFilters);
    setApplied(emptyFilters);
    setOffset(0);
    setRefreshVersion((current) => current + 1);
  }

  function exportPage() {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `red-router-audit-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Audit log</h1>
          <p className="mt-1 text-text-muted">
            Durable Rust-owned history for configuration, identity, routing and key mutations.
          </p>
          <p className="mt-1 text-sm text-text-muted">
            Showing {events.length} of {total} matching events.
          </p>
        </div>
        <div className="flex gap-3">
          <button type="button" disabled={loading} onClick={refresh}>
            Refresh
          </button>
          <button type="button" disabled={events.length === 0} onClick={exportPage}>
            Export page
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}

      <form
        className="grid gap-3 rounded border border-border p-4 md:grid-cols-2 xl:grid-cols-6"
        onSubmit={applyFilters}
      >
        {(
          [
            ["Action", "action"],
            ["Actor", "actor"],
            ["Target", "target"],
            ["Resource type", "resourceType"],
            ["Status", "status"],
            ["Request ID", "requestId"],
          ] as const
        ).map(([label, key]) => (
          <label className="block" key={key}>
            {label}
            <input
              className={fieldClass}
              value={filters[key]}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [key]: event.target.value }))
              }
            />
          </label>
        ))}
        <div className="flex gap-3 md:col-span-2 xl:col-span-6">
          <button type="submit" disabled={loading}>
            Apply filters
          </button>
          <button type="button" disabled={loading} onClick={clearFilters}>
            Clear
          </button>
        </div>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : events.length === 0 ? (
        <p>No audit events match the current filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th className="border-b border-border p-2">Time</th>
                <th className="border-b border-border p-2">Action</th>
                <th className="border-b border-border p-2">Actor</th>
                <th className="border-b border-border p-2">Organization</th>
                <th className="border-b border-border p-2">Target</th>
                <th className="border-b border-border p-2">Status</th>
                <th className="border-b border-border p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap border-b border-border p-2">
                    {formatDate(event.timestamp)}
                  </td>
                  <td className="border-b border-border p-2">{event.action}</td>
                  <td className="max-w-xs break-all border-b border-border p-2">{event.actor}</td>
                  <td className="border-b border-border p-2">{event.tenantId}</td>
                  <td className="border-b border-border p-2">
                    <span className="block">{event.target}</span>
                    <span className="text-xs text-text-muted">{event.resourceType}</span>
                  </td>
                  <td className="border-b border-border p-2">{event.status}</td>
                  <td className="border-b border-border p-2">
                    <button type="button" onClick={() => setSelected(event)}>
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          disabled={loading || offset === 0}
          onClick={() => {
            setLoading(true);
            setError("");
            setOffset((current) => Math.max(0, current - PAGE_SIZE));
          }}
        >
          Previous
        </button>
        <span>
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + events.length, total)} of {total}
        </span>
        <button
          type="button"
          disabled={loading || offset + events.length >= total}
          onClick={() => {
            setLoading(true);
            setError("");
            setOffset((current) => current + PAGE_SIZE);
          }}
        >
          Next
        </button>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-event-title"
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded bg-surface p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="audit-event-title" className="text-lg font-semibold">
                  {selected.action}
                </h2>
                <p className="break-all text-sm text-text-muted">{selected.id}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <dl className="mt-4 grid gap-2 sm:grid-cols-[10rem_1fr]">
              <dt>Timestamp</dt>
              <dd>{formatDate(selected.timestamp)}</dd>
              <dt>Actor</dt>
              <dd className="break-all">{selected.actor}</dd>
              <dt>Organization</dt>
              <dd>{selected.tenantId}</dd>
              <dt>Target</dt>
              <dd className="break-all">{selected.target}</dd>
              <dt>Resource</dt>
              <dd>{selected.resourceType}</dd>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
              <dt>Request ID</dt>
              <dd className="break-all">{selected.requestId || "—"}</dd>
            </dl>
            <h3 className="mt-5 font-semibold">Details</h3>
            <pre className="mt-2 overflow-auto rounded bg-bg p-3 text-xs">
              {formatJson(selected.details)}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
