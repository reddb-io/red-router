import { useEffect, useState } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Target = {
  id: string;
  attempt: number;
  status: number;
  error: string | null;
  provider: string;
  provider_id: string;
  model: string;
  duration_ms: number;
  ttft_ms: number | null;
  outcome: "selected" | "fallback" | "related";
  reason: string;
};
type Factor = {
  name: string;
  value: string;
  status: "positive" | "warning" | "negative" | "neutral";
  details: string;
};
type Explanation = {
  request_id: string;
  route_type: "combo" | "direct";
  confidence: string;
  summary: string;
  score: number;
  attempts: Target[];
  target_stats: { sample_size: number; success_rate: number; avg_latency_ms: number };
  factors: Factor[];
  recommendations: string[];
  limitations: string[];
};

function isExplanation(value: unknown): value is Explanation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === "string" &&
    Array.isArray(record.attempts) &&
    Array.isArray(record.factors) &&
    Array.isArray(record.recommendations) &&
    Array.isArray(record.limitations)
  );
}

const TONE: Record<Factor["status"], string> = {
  positive: "text-success",
  warning: "text-warning",
  negative: "text-error",
  neutral: "",
};

/** Why one logged request went where it went (legacy route explain). */
export default function RouteExplanation({ id, onClose }: { id: string; onClose: () => void }) {
  // The result for the latest id; one for another id reads as loading.
  const [result, setResult] = useState<{
    id: string;
    explanation: Explanation | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    rustAdminFetch(`/api/admin/request-log/${encodeURIComponent(id)}/explain`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) throw new Error("This request is no longer in the log.");
        if (!response.ok) throw new Error(`Route explanation unavailable (${response.status})`);
        const data: unknown = await response.json();
        if (!isExplanation(data)) throw new Error("Invalid route explanation");
        setResult({ id, explanation: data, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({
            id,
            explanation: null,
            error: cause instanceof Error ? cause.message : "Route explanation unavailable",
          });
      });
    return () => controller.abort();
  }, [id]);
  const current = result?.id === id ? result : null;
  const explanation = current?.explanation ?? null;
  const error = current?.error ?? "";

  return (
    <section
      aria-label="Route explanation"
      className="flex flex-col gap-3 rounded border border-border bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Route explanation</h2>
        <button type="button" className="rounded border border-border px-3 py-1" onClick={onClose}>
          Close
        </button>
      </div>
      {!explanation && !error && <p>Loading explanation…</p>}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {explanation && (
        <>
          <p>{explanation.summary}</p>
          <p>
            <small>
              {explanation.route_type} route · score {explanation.score} · confidence{" "}
              {explanation.confidence} · {explanation.target_stats.success_rate}% success over{" "}
              {explanation.target_stats.sample_size} recent attempts, average{" "}
              {explanation.target_stats.avg_latency_ms.toLocaleString()} ms
            </small>
          </p>
          <h3 className="font-semibold">Attempts</h3>
          <ol className="list-decimal pl-6">
            {explanation.attempts.map((target) => (
              <li key={target.id}>
                <strong>{target.outcome}</strong> · {target.provider_id || "—"} / {target.model} ·
                HTTP {target.status} · {target.duration_ms.toLocaleString()} ms
                {target.ttft_ms !== null && ` (first chunk ${target.ttft_ms.toLocaleString()} ms)`}
                <br />
                <small>{target.reason}</small>
              </li>
            ))}
          </ol>
          <h3 className="font-semibold">Factors</h3>
          <ul className="pl-2">
            {explanation.factors.map((factor) => (
              <li key={factor.name}>
                <span className={TONE[factor.status]}>{factor.name}</span>: {factor.value}
                <br />
                <small>{factor.details}</small>
              </li>
            ))}
          </ul>
          <h3 className="font-semibold">Recommendations</h3>
          <ul className="list-disc pl-6">
            {explanation.recommendations.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
          <details>
            <summary>Limitations</summary>
            <ul className="list-disc pl-6">
              {explanation.limitations.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
