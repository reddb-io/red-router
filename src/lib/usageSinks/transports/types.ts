/**
 * Usage sink transports: how one outbox delivery leaves RedRouter.
 *
 * The engine (`../engine.ts`) owns the billing contract: the outbox, stable delivery ids, the
 * lease, the retry schedule and window semantics. A transport only knows how to put ONE payload
 * on the wire and to say whether a failure is worth retrying. It never touches the database,
 * never throws (failures resolve to `ok: false`), and receives its config already decrypted.
 *
 * Adding a transport = one file under `transports/` and one line in `transports/index.ts`; the
 * engine, the REST layer and the dashboard form read the descriptors below (the same registry
 * model `src/lib/logExport/` uses for its destinations, whose `LogExportConfigField` UI
 * descriptor and secret handling are reused here).
 */

import type { ZodType } from "zod";
import type { LogExportConfigField } from "@/lib/logExport/types";

export type UsageSinkType = "webhook" | "sqs" | "kafka" | "reddb";

/** Outcome of one send attempt. `error` is already sanitized: no credentials, no stack. */
export interface DeliveryResult {
  ok: boolean;
  /** False when retrying cannot help (bad config, 410 Gone, oversized payload). */
  retryable: boolean;
  /** HTTP status for HTTP-based transports; null for Kafka and for network failures. */
  status: number | null;
  statusText: string | null;
  error: string | null;
  /** Display target with credentials and query string removed. */
  target: string | null;
  bytes: number | null;
  durationMs: number | null;
}

/** Egress-guarded fetch used by every HTTP-based transport (injected in tests). */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Minimal producer surface of kafkajs that the Kafka transport uses. */
export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{ key: string; value: string; headers: Record<string, string> }>;
  }): Promise<Array<{ partition?: number; baseOffset?: string; offset?: string }>>;
}

export interface KafkaClientOptions {
  clientId: string;
  brokers: string[];
  ssl: boolean;
  sasl?: { mechanism: string; username: string; password: string };
  connectionTimeout: number;
  requestTimeout: number;
  retry: { retries: number };
}

/** Creates a Kafka client; the default loads kafkajs on first use. */
export type KafkaFactory = (options: KafkaClientOptions) => Promise<{
  producer(options: { allowAutoTopicCreation: boolean }): KafkaProducerLike;
}>;

export interface TransportDeps {
  httpFetch?: HttpFetch;
  kafkaFactory?: KafkaFactory;
}

export interface SendInput<TConfig> {
  /** Decrypted config, already validated by `configSchema`. */
  config: TConfig;
  /** The delivery id: stable across retries, the receiver's dedupe key. */
  id: string;
  sinkId: string;
  payload: Record<string, unknown>;
  /** Engine clock in ms, so signatures and timestamps follow the engine's `now`. */
  now: number;
}

export interface UsageSinkTransport<TConfig = Record<string, unknown>> {
  type: UsageSinkType;
  label: string;
  description: string;
  /** Config keys holding credentials: encrypted at rest, never returned by the API. */
  secretFields: readonly string[];
  /** UI descriptors: the dashboard form is rendered from these. */
  fields: readonly LogExportConfigField[];
  configSchema: ZodType<TConfig>;
  /** One-line, credential-free description of the destination. */
  summary(config: TConfig): string;
  send(input: SendInput<TConfig>, deps?: TransportDeps): Promise<DeliveryResult>;
}
