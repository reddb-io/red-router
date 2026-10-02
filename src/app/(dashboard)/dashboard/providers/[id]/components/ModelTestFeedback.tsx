"use client";

export interface ModelTestFeedbackState {
  model: string;
  status: "testing" | "ok" | "error";
  message: string;
  latencyMs?: number;
  statusCode?: number;
}

export default function ModelTestFeedback({ result }: { result: ModelTestFeedbackState | null }) {
  if (!result) return null;
  return (
    <div
      role={result.status === "error" ? "alert" : "status"}
      aria-live="polite"
      aria-busy={result.status === "testing"}
      className="mb-4 rounded-lg border border-border bg-sidebar/50 p-3 text-sm"
    >
      <p className="font-medium">
        {result.status === "testing"
          ? "Testing model"
          : result.status === "ok"
            ? "Model test passed"
            : "Model test failed"}
      </p>
      <code className="break-all text-xs text-text-muted">{result.model}</code>
      <p
        className={
          result.status === "error"
            ? "mt-1 text-feedback-danger-foreground"
            : "mt-1 text-text-muted"
        }
      >
        {result.message}
      </p>
      {(result.statusCode !== undefined || result.latencyMs !== undefined) && (
        <p className="mt-1 text-xs text-text-muted">
          {result.statusCode !== undefined && `HTTP ${result.statusCode}`}
          {result.statusCode !== undefined && result.latencyMs !== undefined && " · "}
          {result.latencyMs !== undefined && `${result.latencyMs} ms`}
        </p>
      )}
    </div>
  );
}
