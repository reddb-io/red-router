import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Entry = {
  row_id: string;
  key_id: string;
  tenant_id: string | null;
  provider: string;
  model: string;
  timestamp: string;
  tokens_input: string;
  tokens_output: string;
  tokens_reasoning: string;
  amount_usd: number;
  pricing_known: boolean;
  success: boolean;
};
type Page = { available: boolean; entries: Entry[]; next_cursor: string | null };

export default function LegacyUsage() {
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<{ key: string; cursor: string | null }>({
    key: "",
    cursor: null,
  });
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "50" });
    if (selection.key) query.set("key_id", selection.key);
    if (selection.cursor) query.set("cursor", selection.cursor);
    rustAdminFetch(`/api/admin/legacy-usage?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Historical usage unavailable (${response.status})`);
        const data = await response.json();
        if (!data?.legacy_usage || !Array.isArray(data.legacy_usage.entries))
          throw new Error("Invalid historical usage report");
        setPage(data.legacy_usage as Page);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Historical usage unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selection]);
  const navigate = (next: { key: string; cursor: string | null }) => {
    setLoading(true);
    setError("");
    setSelection(next);
  };
  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Historical usage</h1>
      <p>
        Cost ledger staged from the previous RedRouter. It is not yet included in current quotas,
        totals or exports.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ key: filter.trim(), cursor: null });
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
      {loading && <p>Loading historical usage…</p>}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {!loading &&
        !error &&
        page &&
        (page.available ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Key</th>
                    <th>Tenant</th>
                    <th>Provider / model</th>
                    <th>Tokens</th>
                    <th>Cost (USD)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {page.entries.map((entry) => (
                    <tr key={entry.row_id}>
                      <td>{entry.timestamp}</td>
                      <td>{entry.key_id}</td>
                      <td>{entry.tenant_id ?? "Unattributed"}</td>
                      <td>
                        {entry.provider} / {entry.model}
                      </td>
                      <td>
                        {entry.tokens_input} in / {entry.tokens_output} out /{" "}
                        {entry.tokens_reasoning} reasoning
                      </td>
                      <td>{entry.pricing_known ? `$${entry.amount_usd}` : "Unpriced"}</td>
                      <td>{entry.success ? "Success" : "Failed"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {page.entries.length === 0 && <p>No historical usage found.</p>}
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
        ) : (
          <p>No legacy usage archive has been staged.</p>
        ))}
    </section>
  );
}
