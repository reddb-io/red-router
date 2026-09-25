// Amazon SQS transport: SendMessage over the JSON protocol, signed with AWS
// Signature Version 4 by hand so no AWS SDK is needed. Works with any
// SQS-compatible endpoint (LocalStack, ElasticMQ) at the queue URL's origin.
// FIFO queues (".fifo") get the delivery id as MessageDeduplicationId and the
// sink id as MessageGroupId, so a retried delivery is not enqueued twice within
// SQS's 5-minute dedup window and deliveries stay in order.
import { createHash, createHmac } from "node:crypto";

const TIMEOUT_MS = 10_000;
const SERVICE = "sqs";

const sha256Hex = (data) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

/** "20150830T123600Z" for a Date. */
export function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * AWS Signature Version 4 for a request whose path has no query string.
 * Returns the headers to send: the given ones plus x-amz-date, the session
 * token when set, and authorization.
 */
export function signV4({ method, url, headers = {}, body = "", region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const u = new URL(url);
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const all = { ...headers, host: u.host, "x-amz-date": stamp, ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}) };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const signedHeaders = names.join(";");
  const canonical = [
    method,
    u.pathname || "/",
    u.search.replace(/^\?/, ""),
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const { host: _host, ...rest } = all;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The region in an AWS queue URL ("https://sqs.us-east-1.amazonaws.com/…"), or null. */
export function regionFromQueueUrl(queueUrl) {
  try {
    return new URL(queueUrl).hostname.match(/^sqs\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/)?.[1] || null;
  } catch {
    return null;
  }
}

export const isFifoQueue = (queueUrl) => /\.fifo$/.test(String(queueUrl || "").replace(/\/+$/, ""));

/**
 * Enqueue one payload. Resolves to the same shape as sendWebhook:
 * { ok, retryable, status, statusText, bytes, durationMs, error, url }; never throws.
 */
export async function sendSqs({ config, id, payload, sinkId = "redrouter", fetchImpl = fetch, now = Date.now() }) {
  const queueUrl = config?.queueUrl;
  const started = Date.now();
  const result = { ok: false, retryable: true, status: null, statusText: null, bytes: null, durationMs: null, error: null, url: queueUrl || null };
  const region = config?.region || regionFromQueueUrl(queueUrl);
  if (!queueUrl || !region) return { ...result, retryable: false, error: "An SQS queue URL and region are required" };
  if (!config.accessKeyId || !config.secretAccessKey) return { ...result, retryable: false, error: "AWS access key id and secret are required" };

  const endpoint = `${new URL(queueUrl).origin}/`;
  const message = {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(payload),
    MessageAttributes: { "redrouter-delivery-id": { DataType: "String", StringValue: id } },
    ...(isFifoQueue(queueUrl) ? { MessageGroupId: sinkId, MessageDeduplicationId: id.slice(0, 128) } : {}),
  };
  const body = JSON.stringify(message);
  const headers = signV4({
    method: "POST",
    url: endpoint,
    headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.SendMessage" },
    body,
    region,
    service: SERVICE,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken || undefined,
    date: new Date(now),
  });

  try {
    const res = await fetchImpl(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text().catch(() => "");
    result.durationMs = Date.now() - started;
    result.status = res.status;
    result.statusText = res.statusText || null;
    result.bytes = Buffer.byteLength(text);
    result.ok = res.status >= 200 && res.status < 300;
    if (!result.ok) {
      let detail = text.slice(0, 200);
      try {
        const err = JSON.parse(text);
        detail = [err.__type?.split("#").pop(), err.message || err.Message].filter(Boolean).join(": ") || detail;
      } catch { /* not JSON */ }
      // Retried like a webhook: credentials and queue policies get fixed while it waits.
      result.error = `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
    }
    return result;
  } catch (error) {
    result.durationMs = Date.now() - started;
    result.error = error?.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : (error?.message || String(error));
    return result;
  }
}
