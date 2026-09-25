// Usage sink transports: how a delivery leaves RedRouter. Each one validates its
// own config, redacts it for the API (secrets are never sent back; an empty
// secret on update keeps the stored one) and sends one payload. Every `send`
// resolves to { ok, retryable, status, statusText, bytes, durationMs, error, url }
// and never throws; the engine owns retries and the outbox.
import { sendWebhook } from "./webhook.js";
import { sendSqs, regionFromQueueUrl, isFifoQueue } from "./sqs.js";
import { sendKafka, parseBrokers, SASL_MECHANISMS } from "./kafka.js";
import { sendReddbQueue, QUEUE_NAME } from "./reddb.js";

const str = (value) => (typeof value === "string" ? value.trim() : "");
const hint = (secret) => (secret ? `…${secret.slice(-4)}` : null);
// A secret left empty on update keeps the stored one.
const keep = (input, stored) => str(input) || stored || "";

function httpUrl(value, what) {
  const url = str(value);
  let parsed;
  try { parsed = new URL(url); } catch { return { error: `A valid ${what} is required` }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { error: `${what[0].toUpperCase()}${what.slice(1)} must use HTTP or HTTPS` };
  return { url };
}

const webhook = {
  label: "Webhook",
  send: sendWebhook,
  parseConfig(input = {}, stored = {}) {
    const { url, error } = httpUrl(input.url, "webhook URL");
    if (error) return { error };
    return { value: { url, secret: keep(input.secret, stored.secret) } };
  },
  publicConfig: (c) => ({ url: c.url || "", hasSecret: !!c.secret, secretHint: hint(c.secret) }),
  summary: (c) => `POST ${c.url || ""}`,
};

const sqs = {
  label: "Amazon SQS",
  send: sendSqs,
  parseConfig(input = {}, stored = {}) {
    const { url: queueUrl, error } = httpUrl(input.queueUrl, "SQS queue URL");
    if (error) return { error };
    const region = str(input.region) || regionFromQueueUrl(queueUrl);
    if (!region) return { error: "Region is required for a queue URL outside amazonaws.com" };
    const accessKeyId = str(input.accessKeyId);
    const secretAccessKey = keep(input.secretAccessKey, stored.secretAccessKey);
    if (!accessKeyId || !secretAccessKey) return { error: "AWS access key id and secret access key are required" };
    // "-" clears a stored session token; empty keeps it.
    const sessionToken = str(input.sessionToken) === "-" ? "" : keep(input.sessionToken, stored.sessionToken);
    return { value: { queueUrl, region, accessKeyId, secretAccessKey, sessionToken } };
  },
  publicConfig: (c) => ({
    queueUrl: c.queueUrl || "",
    region: c.region || "",
    accessKeyId: c.accessKeyId || "",
    hasSecret: !!c.secretAccessKey,
    secretHint: hint(c.secretAccessKey),
    hasSessionToken: !!c.sessionToken,
    fifo: isFifoQueue(c.queueUrl),
  }),
  summary: (c) => `SQS ${String(c.queueUrl || "").split("/").pop()} (${c.region || "?"})`,
};

const kafka = {
  label: "Kafka",
  send: sendKafka,
  parseConfig(input = {}, stored = {}) {
    const brokers = parseBrokers(input.brokers);
    if (!brokers.length) return { error: "At least one Kafka broker (host:port) is required" };
    if (brokers.some((b) => !/^[^\s:/]+:\d{1,5}$/.test(b))) return { error: "Brokers must be host:port, separated by commas" };
    const topic = str(input.topic);
    if (!/^[A-Za-z0-9._-]{1,249}$/.test(topic)) return { error: "A Kafka topic is required (letters, digits, . _ -)" };
    const mechanism = str(input.sasl?.mechanism);
    if (mechanism && !SASL_MECHANISMS.includes(mechanism)) return { error: `SASL mechanism must be one of: ${SASL_MECHANISMS.join(", ")}` };
    const sasl = mechanism
      ? { mechanism, username: str(input.sasl?.username), password: keep(input.sasl?.password, stored.sasl?.password) }
      : null;
    if (sasl && (!sasl.username || !sasl.password)) return { error: "SASL needs a username and password" };
    return { value: { brokers, topic, clientId: str(input.clientId) || "red-router", ssl: input.ssl === true, sasl } };
  },
  publicConfig: (c) => ({
    brokers: c.brokers || [],
    topic: c.topic || "",
    clientId: c.clientId || "red-router",
    ssl: !!c.ssl,
    sasl: c.sasl ? { mechanism: c.sasl.mechanism, username: c.sasl.username, hasPassword: !!c.sasl.password } : null,
  }),
  summary: (c) => `Kafka ${c.topic || "?"} @ ${(c.brokers || [])[0] || "?"}${(c.brokers || []).length > 1 ? ` +${c.brokers.length - 1}` : ""}`,
};

const reddb = {
  label: "RedDB queue",
  send: sendReddbQueue,
  parseConfig(input = {}, stored = {}) {
    const { url, error } = httpUrl(input.url, "RedDB URL");
    if (error) return { error };
    const queue = str(input.queue);
    if (!QUEUE_NAME.test(queue)) return { error: "A queue name is required (letters, digits, _; not starting with a digit)" };
    // "-" clears a stored token; empty keeps it (RedDB without --auth needs none).
    const token = str(input.token) === "-" ? "" : keep(input.token, stored.token);
    return { value: { url: url.replace(/\/+$/, ""), queue, token, tenant: str(input.tenant) } };
  },
  publicConfig: (c) => ({ url: c.url || "", queue: c.queue || "", tenant: c.tenant || "", hasToken: !!c.token, tokenHint: hint(c.token) }),
  summary: (c) => `QUEUE ${c.queue || "?"} @ ${String(c.url || "").replace(/^https?:\/\//, "")}`,
};

export const TRANSPORTS = { webhook, sqs, kafka, reddb };
