import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Summary = {
  requests: number;
  attempts: number;
  served_requests: number;
  success_rate_pct: number;
  fallback_requests: number;
  fallback_rate_pct: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  errors: Array<{ error: string; count: number }>;
};

function isSummary(value: unknown): value is Summary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.requests === "number" && Array.isArray(record.errors);
}

/** Request totals of the last 7 days (legacy analytics summary). */
export default function RequestSummary({ refresh }: { refresh: number }) {
  // The result of the latest refresh; an older one reads as loading.
  const [result, setResult] = useState<{
    refresh: number;
    summary: Summary | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    rustAdminFetch("/api/admin/request-log/summary", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Request summary unavailable (${response.status})`);
        const data: unknown = await response.json();
        const summary = (data as { summary?: unknown } | null)?.summary;
        if (!isSummary(summary)) throw new Error("Invalid request summary");
        setResult({ refresh, summary, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            refresh,
            summary: null,
            error: cause instanceof Error ? cause.message : "Request summary unavailable",
          });
      });
    return () => controller.abort();
  }, [refresh]);

  const current = result?.refresh === refresh ? result : null;
  if (current?.error) return <p className="text-error">{current.error}</p>;
  const summary = current?.summary;
  if (!summary) return <p>Loading summary…</p>;
  const tiles: Array<[string, string]> = [
    ["Requests", summary.requests.toLocaleString()],
    ["Success rate", `${summary.success_rate_pct}%`],
    [
      "Served after fallback",
      `${summary.fallback_requests.toLocaleString()} (${summary.fallback_rate_pct}%)`,
    ],
    ["Average latency", `${summary.avg_latency_ms.toLocaleString()} ms`],
    [
      "Average first chunk",
      summary.avg_ttft_ms === null ? "—" : `${summary.avg_ttft_ms.toLocaleString()} ms`,
    ],
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-surface p-3">
            <dt className="text-sm">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {summary.errors.length > 0 && (
        <p className="text-sm">
          Failed attempts:{" "}
          {summary.errors.map((entry) => `${entry.error} × ${entry.count}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
