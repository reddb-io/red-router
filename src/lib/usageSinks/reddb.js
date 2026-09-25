// RedDB queue transport: `QUEUE PUSH <queue> <json> DEDUP '<delivery id>'` sent
// to RedDB's HTTP query endpoint (POST /query, Bearer token), the same statement
// @reddb-io/client builds for db.queue.push. DEDUP makes a retried delivery a
// no-op while it is inside the queue's dedup window (5 minutes by default,
// DEDUP_WINDOW on CREATE/ALTER QUEUE). Create the queue once, e.g.
//   CREATE QUEUE IF NOT EXISTS usage_events WITH DEDUP_WINDOW 1h
const TIMEOUT_MS = 10_000;
// RedDB parses at most 1 MiB of statement text by default.
const MAX_STATEMENT_BYTES = 1024 * 1024;
export const QUEUE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The statement that enqueues one payload. */
export function queuePushStatement(queue, payload, dedupId) {
  return `QUEUE PUSH ${queue} ${JSON.stringify(payload)} DEDUP '${String(dedupId).replace(/'/g, "''")}'`;
}

export const queryEndpoint = (url) => `${String(url || "").replace(/\/+$/, "")}/query`;

/**
 * Push one payload. Resolves to the shape the other transports use:
 * { ok, retryable, status, statusText, bytes, durationMs, error, url }; never throws.
 */
export async function sendReddbQueue({ config, id, payload, fetchImpl = fetch }) {
  const started = Date.now();
  const endpoint = config?.url ? queryEndpoint(config.url) : null;
  const result = { ok: false, retryable: true, status: null, statusText: null, bytes: null, durationMs: null, error: null, url: endpoint };
  if (!endpoint || !QUEUE_NAME.test(config?.queue || "")) return { ...result, retryable: false, error: "A RedDB URL and queue name are required" };

  const query = queuePushStatement(config.queue, payload, id);
  if (Buffer.byteLength(query) > MAX_STATEMENT_BYTES) {
    return { ...result, retryable: false, error: `Payload too large for one RedDB statement (${Buffer.byteLength(query)} bytes, limit ${MAX_STATEMENT_BYTES})` };
  }
  const headers = { "content-type": "application/json", "user-agent": "RedRouter-UsageSinks/1" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.tenant) headers["x-reddb-tenant"] = config.tenant;

  try {
    const res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify({ query }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text().catch(() => "");
    result.durationMs = Date.now() - started;
    result.status = res.status;
    result.statusText = res.statusText || null;
    result.bytes = Buffer.byteLength(text);
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    result.ok = res.status >= 200 && res.status < 300 && body?.ok !== false;
    if (!result.ok) result.error = `HTTP ${res.status}${body?.error ? `: ${String(body.error).slice(0, 200)}` : text ? `: ${text.slice(0, 200)}` : ""}`;
    return result;
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.error = error?.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : (error?.message || String(error));
    return result;
  }
}
