"use client";

import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { cn } from "@/shared/utils/cn";

// HTTP/2 responses carry no reason phrase, so the common ones are named here.
const REASONS = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 408: "Timeout", 409: "Conflict", 413: "Too Large", 422: "Unprocessable",
  429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Unavailable", 504: "Gateway Timeout",
};

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(request) {
  if (!request) return "No request";
  // Non-HTTP transports (Kafka) answer without a status code but with a result.
  if (request.status === null) return request.statusText || (request.error ? "No response" : "Not sent");
  return `${request.status} ${request.statusText || REASONS[request.status] || ""}`.trim();
}

// The tone follows the test's verdict; a 2xx that still failed (e.g. no models) reads as a warning.
function statusVariant(valid, request) {
  if (valid) return "success";
  if (request?.status >= 200 && request?.status < 300) return "warning";
  return "danger";
}

function Endpoint({ request }) {
  if (!request?.url) return null;
  return (
    <span className="min-w-0 truncate font-mono text-xs text-ink-muted" title={`${request.method} ${request.url}`}>
      {request.method} {request.url.replace(/^https?:\/\//, "")}
    </span>
  );
}

/**
 * The outcome of a connection test: HTTP status, latency and response size of
 * the request that decided it, the failure reason, and every request it made.
 */
export default function ConnectionTestResult({ result, testing = false, className }) {
  if (testing) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-ink-muted", className)} role="status">
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
        Testing…
      </div>
    );
  }
  if (!result) return null;

  const probe = result.probe || null;
  const requests = result.requests || [];
  const size = formatBytes(probe?.bytes);
  const latency = result.latencyMs ?? probe?.durationMs;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} role="status">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={statusVariant(result.valid, probe)} size="sm" dot>
          {statusLabel(probe)}
        </Badge>
        {latency !== null && latency !== undefined && (
          <span className="font-mono text-xs tabular-nums text-foreground" title="Total test time">{latency} ms</span>
        )}
        {size && <span className="font-mono text-xs tabular-nums text-foreground" title="Response size">{size}</span>}
        <Endpoint request={probe} />
      </div>
      {!result.valid && result.error && (
        <p className="text-xs text-feedback-danger-foreground">{result.error}</p>
      )}
      {requests.length > 1 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer select-none">{requests.length} requests</summary>
          <ol className="mt-1 flex flex-col gap-1">
            {requests.map((request, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-3 font-mono tabular-nums">
                <span className="text-foreground">{statusLabel(request)}</span>
                {request.durationMs !== null && <span>{request.durationMs} ms</span>}
                {formatBytes(request.bytes) && <span>{formatBytes(request.bytes)}</span>}
                <Endpoint request={request} />
                {request.error && <span className="text-feedback-danger-foreground">{request.error}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

const requestShape = PropTypes.shape({
  method: PropTypes.string,
  url: PropTypes.string,
  status: PropTypes.number,
  statusText: PropTypes.string,
  bytes: PropTypes.number,
  durationMs: PropTypes.number,
  error: PropTypes.string,
});

ConnectionTestResult.propTypes = {
  result: PropTypes.shape({
    valid: PropTypes.bool,
    error: PropTypes.string,
    latencyMs: PropTypes.number,
    probe: requestShape,
    requests: PropTypes.arrayOf(requestShape),
  }),
  testing: PropTypes.bool,
  className: PropTypes.string,
};
