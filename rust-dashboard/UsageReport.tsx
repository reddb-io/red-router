import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Entry = {
  event_id: string;
  key_id: string;
  key_name: string;
  tenant_id: string;
  provider: string;
  model: string;
  usage_kind: string;
  search_units: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  amount_microusd: number;
  pricing_known: boolean;
  created_at_unix_ms: number;
};
type Report = {
  request_count: number;
  priced_request_count: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  search_units: number;
  amount_microusd: number;
  pending_request_count: number;
  next_cursor: string | null;
  entries: Entry[];
};

type BreakdownBy = "model" | "provider" | "key" | "day";
type BreakdownGroup = {
  group: string;
  label: string;
  request_count: number;
  priced_request_count: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  search_units: number;
  amount_microusd: number;
};

function UsageBreakdown({ keyId, until }: { keyId: string; until: number }) {
  const [by, setBy] = useState<BreakdownBy>("model");
  // The result of the latest query; one for other parameters reads as loading.
  const [result, setResult] = useState<{
    key: string;
    groups: BreakdownGroup[] | null;
    error: string;
  } | null>(null);
  const requestKey = `${by}|${keyId}|${until}`;

  useEffect(() => {
    const controller = new AbortController();
    const key = `${by}|${keyId}|${until}`;
    const query = new URLSearchParams({
      by,
      from_unix_ms: String(until - 30 * 24 * 60 * 60 * 1_000),
      to_unix_ms: String(until),
    });
    if (keyId) query.set("key_id", keyId);
    rustAdminFetch(`/api/admin/usage/breakdown?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Usage breakdown unavailable (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.breakdown?.groups)) throw new Error("Invalid usage breakdown");
        setResult({ key, groups: data.breakdown.groups as BreakdownGroup[], error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            groups: null,
            error: cause instanceof Error ? cause.message : "Usage breakdown unavailable",
          });
      });
    return () => controller.abort();
  }, [by, keyId, until]);
  const current = result?.key === requestKey ? result : null;
  const groups = current?.groups ?? null;
  const error = current?.error ?? "";

  return (
    <div className="flex flex-col gap-2">
      <label>
        Breakdown by{" "}
        <select
          className="rounded border border-border bg-surface px-3 py-2"
          value={by}
          onChange={(event) => setBy(event.target.value as BreakdownBy)}
        >
          <option value="model">Model</option>
          <option value="provider">Provider</option>
          <option value="key">API key</option>
          <option value="day">Day (UTC)</option>
        </select>
      </label>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!error && !groups && <p>Loading breakdown…</p>}
      {groups && groups.length === 0 && <p>No usage in this period.</p>}
      {groups && groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>{by === "day" ? "Day" : by === "key" ? "API key" : by === "provider" ? "Provider" : "Model"}</th>
                <th>Requests</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.group}>
                  <td>
                    {group.label}
                    {group.label !== group.group && <small> ({group.group})</small>}
                  </td>
                  <td>
                    {group.request_count.toLocaleString()}
                    {group.priced_request_count < group.request_count && (
                      <small> ({group.priced_request_count.toLocaleString()} priced)</small>
                    )}
                  </td>
                  <td>{group.tokens_input.toLocaleString()}</td>
                  <td>{group.tokens_output.toLocaleString()}</td>
                  <td>{money(group.amount_microusd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function money(micros: number): string {
  return Number.isSafeInteger(micros)
    ? `$${(micros / 1_000_000).toFixed(6)}`
    : "Amount unavailable";
}

export default function UsageReport() {
  const [until] = useState(() => Date.now() + 1_000);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<{ keyId: string; cursor: string | null }>({
    keyId: "",
    cursor: null,
  });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      from_unix_ms: String(until - 30 * 24 * 60 * 60 * 1_000),
      to_unix_ms: String(until),
      limit: "50",
    });
    if (selection.keyId) query.set("key_id", selection.keyId);
    if (selection.cursor) query.set("cursor", selection.cursor);
    rustAdminFetch(`/api/admin/usage?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Usage report unavailable (${response.status})`);
        const data = await response.json();
        if (!data?.usage || !Array.isArray(data.usage.entries))
          throw new Error("Invalid usage report");
        setReport(data.usage as Report);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Usage report unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selection, until]);

  const navigate = (next: { keyId: string; cursor: string | null }) => {
    setLoading(true);
    setError("");
    setSelection(next);
  };

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Usage report</h1>
      <p>Last 30 days · UTC · amounts exclude requests without known pricing.</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ keyId: filter.trim(), cursor: null });
        }}
      >
        <label>
          API key ID{" "}
          <input
            className="rounded border border-border bg-surface px-3 py-2"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <button className="rounded border border-border px-3 py-2" type="submit">
          Filter
        </button>
      </form>
      {loading && <p>Loading usage…</p>}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!loading && !error && report && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <p>
              Requests: {report.request_count.toLocaleString()} (
              {report.priced_request_count.toLocaleString()} priced)
            </p>
            <p>Spend: {money(report.amount_microusd)}</p>
            <p>Pending reservations: {report.pending_request_count.toLocaleString()}</p>
            <p>Input tokens: {report.tokens_input.toLocaleString()}</p>
            <p>
              Output tokens: {report.tokens_output.toLocaleString()} · Reasoning:{" "}
              {report.tokens_reasoning.toLocaleString()}
            </p>
            <p>Rerank search units: {report.search_units.toLocaleString()}</p>
          </div>
          <UsageBreakdown keyId={selection.keyId} until={until} />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Key</th>
                  <th>Tenant</th>
                  <th>Provider / model</th>
                  <th>Usage</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {report.entries.map((entry) => (
                  <tr key={entry.event_id}>
                    <td>{new Date(entry.created_at_unix_ms).toISOString()}</td>
                    <td>
                      {entry.key_name} ({entry.key_id})
                    </td>
                    <td>{entry.tenant_id}</td>
                    <td>
                      {entry.provider} / {entry.model}
                    </td>
                    <td>
                      {entry.usage_kind === "rerank"
                        ? `${entry.search_units.toLocaleString()} search units`
                        : `${entry.tokens_input.toLocaleString()} in / ${entry.tokens_output.toLocaleString()} out / ${entry.tokens_reasoning.toLocaleString()} reasoning`}
                    </td>
                    <td>{entry.pricing_known ? money(entry.amount_microusd) : "Unpriced"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.entries.length === 0 && <p>No usage in this period.</p>}
          <div className="flex gap-4">
            {selection.cursor && (
              <button type="button" onClick={() => navigate({ ...selection, cursor: null })}>
                First page
              </button>
            )}
            {report.next_cursor && (
              <button
                type="button"
                onClick={() => navigate({ ...selection, cursor: report.next_cursor })}
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
