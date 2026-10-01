"use client";

import { useEffect, useState } from "react";
import { Button, Badge } from "@/shared/components";

export interface ConnectionHealth {
  rateLimitedUntil?: string | null;
  testStatus?: string | null;
  lastError?: string | null;
  lastTested?: string | null;
}
interface Props {
  connectionId: string;
  health: ConnectionHealth;
  draft?: { baseUrl?: string; apiKey?: string; validationModelId?: string };
}
interface Result {
  valid: boolean;
  skipped?: boolean;
  error?: string;
  warning?: string;
  statusCode?: number;
  latencyMs?: number;
  rateLimitedUntil?: string | null;
}

export default function ConnectionTestControl(props: Props) {
  return (
    <ConnectionProbe
      key={JSON.stringify({ id: props.connectionId, draft: props.draft })}
      {...props}
    />
  );
}

function ConnectionProbe({ connectionId, health, draft }: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const fingerprint = JSON.stringify({ connectionId, draft });

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const input = JSON.parse(fingerprint) as { connectionId: string; draft?: Props["draft"] };
    let disposed = false;
    void fetch(`/api/providers/${encodeURIComponent(input.connectionId)}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.draft ? { draft: input.draft } : {}),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (controller.signal.aborted) return;
        setResult({
          valid: response.ok && data.valid === true,
          skipped: data.skipped === true,
          error: typeof data.error === "string" ? data.error : data.error?.message,
          warning: typeof data.warning === "string" ? data.warning : undefined,
          statusCode: data.statusCode || (!response.ok ? response.status : undefined),
          latencyMs: data.latencyMs,
          rateLimitedUntil: data.rateLimitedUntil,
        });
      })
      .catch(() => {
        // On field changes/unmount the cleanup clears the timeout first. A timeout
        // displays a result; an obsolete request must not overwrite the new form.
        if (!disposed)
          setResult({
            valid: false,
            error: controller.signal.aborted
              ? "Test timed out after 45 seconds. Check the address and network access."
              : "Unable to reach the test service. Check the network and retry.",
          });
      })
      .finally(() => {
        clearTimeout(timer);
        if (!disposed) setTesting(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, fingerprint]);

  const cooldown =
    result?.rateLimitedUntil !== undefined ? result.rateLimitedUntil : health.rateLimitedUntil;
  const until = Date.parse(cooldown || "");
  useEffect(() => {
    if (!(until > Date.now())) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  const cooling = until > now;

  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label="Connection diagnostics">
      <div className="space-y-1 text-sm">
        {cooling ? (
          <p role="status" className="text-feedback-warning-foreground">
            Routing cooldown: {Math.ceil((until - now) / 1000)}s remaining, until{" "}
            {new Date(until).toLocaleTimeString()}.
          </p>
        ) : (
          <p className="text-text-muted">No active connection cooldown.</p>
        )}
        {health.testStatus && <p className="text-text-muted">Saved status: {health.testStatus}</p>}
        {!result && health.lastError && (
          <p className="text-text-muted">Last error: {health.lastError}</p>
        )}
        <p className="text-xs text-text-muted">
          Manual tests bypass routing cooldown and never add a cooldown on failure.
          {draft
            ? " Tests the current URL, API key and probe model without saving. Other settings use saved values. A blank key uses the saved key."
            : " Tests the saved connection. A successful probe can recover transient errors; quota windows remain in effect."}
        </p>
      </div>
      <Button
        variant="secondary"
        disabled={testing}
        onClick={() => {
          setTesting(true);
          setResult(null);
          setAttempt((value) => value + 1);
        }}
      >
        {testing
          ? "Testing connection…"
          : draft
            ? "Test current settings"
            : "Test saved connection"}
      </Button>
      {result && (
        <div role={result.valid ? "status" : "alert"} className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={result.skipped ? "warning" : result.valid ? "success" : "error"}>
              {result.skipped
                ? "Not verified"
                : result.valid
                  ? "Connection reached"
                  : "Test failed"}
            </Badge>
            {result.statusCode && <span>HTTP {result.statusCode}</span>}
            {typeof result.latencyMs === "number" && <span>{result.latencyMs} ms</span>}
          </div>
          {result.error && <p>{result.error}</p>}
          {result.warning && <p>{result.warning}</p>}
          {[401, 403].includes(result.statusCode) && (
            <p className="text-text-muted">Check the remote API key and its permissions.</p>
          )}
          {result.statusCode === 404 && (
            <p className="text-text-muted">
              Check the Base URL and endpoint path. RedRouter accepts http://host:25050/v1.
            </p>
          )}
          {draft && result.valid && (
            <p className="text-text-muted">Save the connection to apply these settings.</p>
          )}
        </div>
      )}
    </section>
  );
}
