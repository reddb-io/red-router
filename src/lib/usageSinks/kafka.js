// Kafka transport (kafkajs, loaded on first use). One producer per sink
// configuration, kept connected between ticks and dropped after an error so the
// next attempt reconnects. Messages are keyed by sink id, so one sink's
// deliveries stay in order on one partition; the delivery id travels in the
// `redrouter-delivery-id` header for consumers to dedupe on (delivery is at
// least once, like the other transports).
import { createHash } from "node:crypto";

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const SASL_MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"];

const producers = new Map(); // config digest -> Promise<producer>

/** "host:9092, host2:9092" or an array → ["host:9092", "host2:9092"]. */
export function parseBrokers(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return list.map((b) => String(b).trim()).filter(Boolean);
}

const digest = (config) => createHash("sha256").update(JSON.stringify([
  parseBrokers(config.brokers), config.clientId || "", !!config.ssl, config.sasl?.mechanism || "", config.sasl?.username || "", config.sasl?.password || "",
])).digest("hex");

async function defaultKafkaFactory(options) {
  const { Kafka, logLevel } = await import("kafkajs");
  return new Kafka({ ...options, logLevel: logLevel.NOTHING });
}

function producerFor(config, kafkaFactory) {
  const key = digest(config);
  if (!producers.has(key)) {
    const pending = (async () => {
      const kafka = await kafkaFactory({
        clientId: config.clientId || "red-router",
        brokers: parseBrokers(config.brokers),
        ssl: !!config.ssl,
        ...(config.sasl?.mechanism ? { sasl: { mechanism: config.sasl.mechanism, username: config.sasl.username, password: config.sasl.password } } : {}),
        connectionTimeout: CONNECT_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        retry: { retries: 2 },
      });
      const producer = kafka.producer({ allowAutoTopicCreation: false });
      await producer.connect();
      return producer;
    })();
    producers.set(key, pending);
    pending.catch(() => producers.delete(key));
  }
  return { key, pending: producers.get(key) };
}

async function drop(key) {
  const pending = producers.get(key);
  producers.delete(key);
  try { await (await pending)?.disconnect(); } catch { /* already gone */ }
}

/**
 * Produce one payload. Resolves to the shape the other transports use:
 * { ok, retryable, status, statusText, bytes, durationMs, error, url }; never throws.
 */
export async function sendKafka({ config, id, payload, sinkId = "redrouter", kafkaFactory = defaultKafkaFactory }) {
  const brokers = parseBrokers(config?.brokers);
  const started = Date.now();
  const where = config?.topic ? `kafka://${brokers[0] || "?"}/${config.topic}` : null;
  const result = { ok: false, retryable: true, status: null, statusText: null, bytes: null, durationMs: null, error: null, url: where };
  if (!brokers.length || !config?.topic) return { ...result, retryable: false, error: "Kafka brokers and a topic are required" };

  const { key, pending } = producerFor(config, kafkaFactory);
  try {
    const producer = await pending;
    const value = JSON.stringify(payload);
    const [meta] = await producer.send({
      topic: config.topic,
      messages: [{ key: sinkId, value, headers: { "redrouter-delivery-id": id, "content-type": "application/json" } }],
    });
    result.durationMs = Date.now() - started;
    result.ok = true;
    result.statusText = meta ? `partition ${meta.partition}, offset ${meta.baseOffset ?? meta.offset ?? "?"}` : "produced";
    result.bytes = Buffer.byteLength(value);
    return result;
  } catch (error) {
    await drop(key);
    result.durationMs = Date.now() - started;
    result.error = error?.message || String(error);
    return result;
  }
}

/** Test hook: forget cached producers (without disconnecting fakes). */
export function resetKafkaProducers() {
  producers.clear();
}
