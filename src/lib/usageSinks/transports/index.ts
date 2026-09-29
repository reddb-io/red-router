/**
 * Usage sink transport registry. The engine, the REST layer and the dashboard form read this and
 * nothing else: adding a transport is one file in this folder and one entry below.
 */
import { kafkaTransport } from "./kafka";
import { redDbTransport } from "./reddb";
import { sqsTransport } from "./sqs";
import type { UsageSinkTransport, UsageSinkType } from "./types";
import { webhookTransport } from "./webhook";

// Transports have different config shapes; callers reach them through the registry, which is
// where the type is erased.
export const TRANSPORTS = {
  webhook: webhookTransport,
  sqs: sqsTransport,
  kafka: kafkaTransport,
  reddb: redDbTransport,
} as const satisfies Record<UsageSinkType, { type: UsageSinkType }>;

export const USAGE_SINK_TYPES = Object.keys(TRANSPORTS) as [UsageSinkType, ...UsageSinkType[]];

export function isUsageSinkType(value: unknown): value is UsageSinkType {
  return typeof value === "string" && Object.hasOwn(TRANSPORTS, value);
}

export function getTransport(type: string): UsageSinkTransport<Record<string, unknown>> | null {
  return isUsageSinkType(type)
    ? (TRANSPORTS[type] as unknown as UsageSinkTransport<Record<string, unknown>>)
    : null;
}

export interface TransportDescriptor {
  type: UsageSinkType;
  label: string;
  description: string;
  fields: UsageSinkTransport["fields"];
}

/** Serializable descriptors for the dashboard form. */
export function describeTransports(): TransportDescriptor[] {
  return USAGE_SINK_TYPES.map((type) => {
    const { label, description, fields } = TRANSPORTS[type];
    return { type, label, description, fields };
  });
}
