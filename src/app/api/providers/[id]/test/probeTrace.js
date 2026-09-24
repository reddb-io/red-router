// Records the upstream HTTP requests a connection test makes, so a test can
// report what actually happened on the wire (status, latency, response size)
// instead of only valid / invalid. One trace per test run, carried through
// async calls by AsyncLocalStorage; outside a trace, recording is a no-op.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
// Measuring a body without a content-length reads a clone of it; don't let a
// slow or endless stream hold the test result.
const SIZE_TIMEOUT_MS = 2000;

/** Run fn inside a fresh trace; resolves to { result, requests }. */
export async function runWithProbeTrace(fn) {
  const trace = { requests: [], pending: [] };
  const result = await storage.run(trace, fn);
  await Promise.all(trace.pending);
  return { result, requests: trace.requests.map(({ startedAt, ...request }) => request) };
}

// Origin + path only: query strings can carry keys (e.g. ?key=).
function displayUrl(url) {
  try {
    const u = new URL(typeof url === "string" ? url : url?.url || String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Call fetchImpl(url, options) and record the exchange in the current trace. */
export async function tracedFetch(fetchImpl, url, options = {}) {
  const trace = storage.getStore();
  if (!trace) return fetchImpl(url, options);

  const request = {
    method: (options.method || "GET").toUpperCase(),
    url: displayUrl(url),
    status: null,
    statusText: null,
    bytes: null,
    durationMs: null,
    error: null,
    startedAt: Date.now(),
  };
  trace.requests.push(request);
  try {
    const res = await fetchImpl(url, options);
    request.durationMs = Date.now() - request.startedAt;
    request.status = res.status;
    request.statusText = res.statusText || null;
    const length = Number.parseInt(res.headers?.get?.("content-length") ?? "", 10);
    if (Number.isFinite(length) && length >= 0) {
      request.bytes = length;
    } else if (typeof res.clone === "function") {
      trace.pending.push(
        withTimeout(res.clone().arrayBuffer().then((buf) => buf.byteLength), SIZE_TIMEOUT_MS)
          .then((size) => { request.bytes = size; })
          .catch(() => {}),
      );
    }
    return res;
  } catch (error) {
    request.durationMs = Date.now() - request.startedAt;
    request.error = error?.name === "TimeoutError" ? "Timed out" : (error?.message || String(error));
    throw error;
  }
}

/**
 * The request that decided the test: the last one that got a response, or the
 * last attempt when none did (DNS failure, timeout).
 */
export function decisiveRequest(requests) {
  for (let i = requests.length - 1; i >= 0; i--) {
    if (requests[i].status !== null) return requests[i];
  }
  return requests[requests.length - 1] || null;
}
