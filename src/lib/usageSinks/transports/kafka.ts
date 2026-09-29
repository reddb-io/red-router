/**
 * Kafka (kafkajs, loaded on first use). One producer per broker configuration is kept connected
 * between ticks and dropped after an error so the next attempt reconnects.
 *
 * Message identity: the record key is the sink id, so one sink's deliveries stay ordered on one
 * partition, and the delivery id travels in the `redrouter-delivery-id` header for consumers to
 * dedupe on (delivery is at least once, like the other transports).
 *
 * Egress: Kafka is raw TCP, so the HTTP guard cannot wrap it. Instead every socket kafkajs opens,
 * including the ones to broker addresses returned in cluster metadata, is created by
 * `createGuardedSocketFactory`: the hostname is resolved by a guarded `lookup` (the address that
 * is validated is the address that is connected to, so there is no rebinding window), cloud
 * metadata addresses are always refused and private/local ones are refused unless the
 * private-provider-URL opt-in is on. Configured brokers are also checked when the sink is saved.
 */
import { createHash } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { z } from "zod";
import { isCloudMetadataHost, isPrivateHost } from "@/shared/network/outboundUrlGuard";
import { arePrivateProviderUrlsAllowed } from "@/shared/network/outboundUrlGuardPolicy";
import { bareHostname } from "@/shared/network/dnsPinnedFetch";
import { blankResult, describeSendError, egressHostIssue, permanentFailure } from "./http";
import type { DeliveryResult, KafkaClientOptions, KafkaFactory, UsageSinkTransport } from "./types";

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Producers kept alive at once; the oldest is disconnected when a sink's config was edited. */
const MAX_CACHED_PRODUCERS = 8;
export const SASL_MECHANISMS = ["plain", "scram-sha-256", "scram-sha-512"] as const;
const BLOCKED_MESSAGE = "Kafka broker address blocked by the egress policy";

export interface KafkaConfig {
  brokers: string[];
  topic: string;
  clientId: string;
  ssl: boolean;
  saslMechanism?: (typeof SASL_MECHANISMS)[number];
  saslUsername?: string;
  saslPassword?: string;
}

/** "host:9092, host2:9092" or an array -> ["host:9092", "host2:9092"]. */
export function parseBrokers(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  return list.map((broker) => String(broker).trim()).filter(Boolean);
}

/** Whether an address must not be connected to (metadata always; private unless opted in). */
export function isBlockedBrokerAddress(address: string): boolean {
  const host = bareHostname(address);
  return isCloudMetadataHost(host) || (isPrivateHost(host) && !arePrivateProviderUrlsAllowed());
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;
type LookupOptions = { all?: boolean; family?: number; hints?: number };
type Resolver = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

/** A `net` lookup that refuses to hand back a blocked address. `resolve` is injectable for tests. */
export function createGuardedLookup(resolve: Resolver = dns.lookup as unknown as Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(
      hostname,
      { all: true, family: options?.family, hints: options?.hints },
      (error, addresses) => {
        if (error) return callback(error, "");
        if (
          !addresses?.length ||
          addresses.some((entry) => isBlockedBrokerAddress(entry.address))
        ) {
          return callback(new Error(BLOCKED_MESSAGE), "");
        }
        // Modern Node (autoSelectFamily) asks for `all` and requires the array form.
        if (options?.all) return callback(null, addresses);
        callback(null, addresses[0].address, addresses[0].family);
      }
    );
  };
}

/** kafkajs `socketFactory`: same sockets as the default one, connected through the guarded lookup. */
export function createGuardedSocketFactory(lookup = createGuardedLookup()) {
  return ({
    host,
    port,
    ssl,
    onConnect,
  }: {
    host: string;
    port: number;
    ssl?: boolean | tls.ConnectionOptions;
    onConnect: () => void;
  }): net.Socket => {
    const bare = bareHostname(host);
    if (net.isIP(bare) && isBlockedBrokerAddress(bare)) {
      // Surface it as a socket error: kafkajs attaches its handlers right after we return.
      const blocked = new net.Socket();
      process.nextTick(() => blocked.destroy(new Error(BLOCKED_MESSAGE)));
      return blocked;
    }
    const socket = ssl
      ? tls.connect(
          {
            host,
            port,
            lookup: lookup as net.LookupFunction,
            ...(net.isIP(bare) ? {} : { servername: host }),
            ...(typeof ssl === "object" ? ssl : {}),
          },
          onConnect
        )
      : net.connect({ host, port, lookup: lookup as net.LookupFunction }, onConnect);
    socket.setKeepAlive(true, 60_000);
    return socket;
  };
}

const defaultKafkaFactory: KafkaFactory = async (options) => {
  const { Kafka, logLevel } = await import("kafkajs");
  return new Kafka({
    ...(options as ConstructorParameters<typeof Kafka>[0]),
    logLevel: logLevel.NOTHING,
    socketFactory: createGuardedSocketFactory() as never,
  }) as unknown as Awaited<ReturnType<KafkaFactory>>;
};

const producers = new Map<
  string,
  Promise<ReturnType<Awaited<ReturnType<KafkaFactory>>["producer"]>>
>();

const digest = (config: KafkaConfig): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        parseBrokers(config.brokers),
        config.clientId || "",
        !!config.ssl,
        config.saslMechanism || "",
        config.saslUsername || "",
        config.saslPassword || "",
      ])
    )
    .digest("hex");

function clientOptions(config: KafkaConfig): KafkaClientOptions {
  return {
    clientId: config.clientId || "red-router",
    brokers: parseBrokers(config.brokers),
    ssl: !!config.ssl,
    ...(config.saslMechanism
      ? {
          sasl: {
            mechanism: config.saslMechanism,
            username: config.saslUsername ?? "",
            password: config.saslPassword ?? "",
          },
        }
      : {}),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    retry: { retries: 2 },
  };
}

function producerFor(config: KafkaConfig, factory: KafkaFactory) {
  const key = digest(config);
  if (!producers.has(key)) {
    if (producers.size >= MAX_CACHED_PRODUCERS) {
      const oldest = producers.keys().next().value as string;
      void drop(oldest);
    }
    const pending = (async () => {
      const kafka = await factory(clientOptions(config));
      const producer = kafka.producer({ allowAutoTopicCreation: false });
      await producer.connect();
      return producer;
    })();
    producers.set(key, pending);
    pending.catch(() => producers.delete(key));
  }
  return { key, pending: producers.get(key)! };
}

async function drop(key: string): Promise<void> {
  const pending = producers.get(key);
  producers.delete(key);
  try {
    await (await pending)?.disconnect();
  } catch {
    // Already gone.
  }
}

/** Test hook: forget cached producers (without disconnecting fakes). */
export function resetKafkaProducers(): void {
  producers.clear();
}

const kafkaConfigSchema = z
  .object({
    brokers: z.preprocess(
      parseBrokers,
      z
        .array(
          z.string().regex(/^[^\s:/]+:\d{1,5}$/, "Brokers must be host:port, separated by commas")
        )
        .min(1, "At least one Kafka broker (host:port) is required")
        .max(20)
    ),
    topic: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,249}$/, "A Kafka topic is required (letters, digits, . _ -)"),
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional()
      .default("red-router"),
    ssl: z.boolean().optional().default(false),
    saslMechanism: z.enum(["", ...SASL_MECHANISMS]).optional(),
    saslUsername: z.string().trim().max(256).optional(),
    saslPassword: z.string().max(1024).optional(),
  })
  .superRefine((config, ctx) => {
    config.brokers.forEach((broker, index) => {
      const [host, port] = [
        broker.slice(0, broker.lastIndexOf(":")),
        Number(broker.split(":").pop()),
      ];
      if (!(port >= 1 && port <= 65535)) {
        ctx.addIssue({ code: "custom", path: ["brokers", index], message: "Port out of range" });
      }
      const issue = egressHostIssue(host);
      if (issue) ctx.addIssue({ code: "custom", path: ["brokers", index], message: issue });
    });
    if (config.saslMechanism && (!config.saslUsername || !config.saslPassword)) {
      ctx.addIssue({
        code: "custom",
        path: ["saslPassword"],
        message: "SASL needs a username and password",
      });
    }
  })
  .transform((config): KafkaConfig => {
    const { saslMechanism, saslUsername, saslPassword, ...rest } = config;
    return (
      saslMechanism ? { ...rest, saslMechanism, saslUsername, saslPassword } : { ...rest }
    ) as KafkaConfig;
  });

const where = (config: KafkaConfig): string | null =>
  config.topic ? `kafka://${parseBrokers(config.brokers)[0] || "?"}/${config.topic}` : null;

export const kafkaTransport: UsageSinkTransport<KafkaConfig> = {
  type: "kafka",
  label: "Kafka",
  description:
    "Produces each delivery keyed by sink id, with the delivery id in the redrouter-delivery-id header.",
  secretFields: ["saslPassword"],
  fields: [
    {
      key: "brokers",
      labelFallback: "Brokers",
      type: "text",
      required: true,
      placeholder: "broker1:9092, broker2:9092",
    },
    {
      key: "topic",
      labelFallback: "Topic",
      type: "text",
      required: true,
      placeholder: "redrouter.usage",
      helpFallback: "The topic must already exist.",
    },
    { key: "clientId", labelFallback: "Client id", type: "text", placeholder: "red-router" },
    { key: "ssl", labelFallback: "Connect over TLS", type: "boolean" },
    {
      key: "saslMechanism",
      labelFallback: "SASL",
      type: "select",
      options: [
        { value: "", labelFallback: "None" },
        { value: "plain", labelFallback: "PLAIN" },
        { value: "scram-sha-256", labelFallback: "SCRAM-SHA-256" },
        { value: "scram-sha-512", labelFallback: "SCRAM-SHA-512" },
      ],
    },
    { key: "saslUsername", labelFallback: "SASL username", type: "text" },
    { key: "saslPassword", labelFallback: "SASL password", type: "password", secret: true },
  ],
  configSchema: kafkaConfigSchema,
  summary: (config) => {
    const brokers = parseBrokers(config.brokers);
    return `Kafka ${config.topic || "?"} @ ${brokers[0] || "?"}${brokers.length > 1 ? ` +${brokers.length - 1}` : ""}`;
  },

  async send({ config, id, sinkId, payload }, deps = {}): Promise<DeliveryResult> {
    const target = where(config);
    if (!parseBrokers(config.brokers).length || !config.topic) {
      return permanentFailure(target, "Kafka brokers and a topic are required");
    }
    const started = Date.now();
    const { key, pending } = producerFor(config, deps.kafkaFactory ?? defaultKafkaFactory);
    try {
      const producer = await pending;
      const value = JSON.stringify(payload);
      const [meta] = await producer.send({
        topic: config.topic,
        messages: [
          {
            key: sinkId,
            value,
            headers: { "redrouter-delivery-id": id, "content-type": "application/json" },
          },
        ],
      });
      return {
        ...blankResult(target),
        ok: true,
        durationMs: Date.now() - started,
        statusText: meta
          ? `partition ${meta.partition}, offset ${meta.baseOffset ?? meta.offset ?? "?"}`
          : "produced",
        bytes: Buffer.byteLength(value),
      };
    } catch (error) {
      await drop(key);
      return {
        ...blankResult(target),
        durationMs: Date.now() - started,
        error: describeSendError(error),
      };
    }
  },
};
