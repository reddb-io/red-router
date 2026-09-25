// Webhook transport, signed per the Standard Webhooks spec
// (https://www.standardwebhooks.com): webhook-id, webhook-timestamp and
// webhook-signature = "v1,<base64 HMAC-SHA256 of `${id}.${timestamp}.${body}`>".
// A secret written as "whsec_<base64>" is used as those decoded bytes;
// any other secret is used as its UTF-8 bytes.
import { createHmac } from "node:crypto";

const TIMEOUT_MS = 10_000;

function secretBytes(secret) {
  if (secret.startsWith("whsec_")) return Buffer.from(secret.slice(6), "base64");
  return Buffer.from(secret, "utf8");
}

export function signWebhook({ id, timestamp, body, secret }) {
  const signature = createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${signature}`;
}

/**
 * POST one payload. Resolves to { ok, retryable, status, statusText, bytes,
 * durationMs, error, url }; never throws.
 */
export async function sendWebhook({ config, id, payload, fetchImpl = fetch, now = Date.now() }) {
  const url = config?.url;
  const started = Date.now();
  const result = { ok: false, retryable: true, status: null, statusText: null, bytes: null, durationMs: null, error: null, url: url || null };
  if (!url) return { ...result, retryable: false, error: "No webhook URL configured" };

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(now / 1000).toString();
  const headers = {
    "content-type": "application/json",
    "user-agent": "RedRouter-UsageSinks/1",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
  };
  if (config.secret) headers["webhook-signature"] = signWebhook({ id, timestamp, body, secret: config.secret });

  try {
    const res = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text().catch(() => "");
    result.durationMs = Date.now() - started;
    result.status = res.status;
    result.statusText = res.statusText || null;
    result.bytes = Buffer.byteLength(text);
    result.ok = res.status >= 200 && res.status < 300;
    // 410 Gone is the Standard Webhooks way to say "stop sending": no retry.
    if (res.status === 410) result.retryable = false;
    if (!result.ok) result.error = `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
    return result;
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.error = error?.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : (error?.message || String(error));
    return result;
  }
}
