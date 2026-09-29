/** Shapes the usage sinks page reads from /api/usage-sinks. */

export interface FieldDescriptor {
  key: string;
  labelFallback: string;
  type: "text" | "password" | "textarea" | "number" | "boolean" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  helpFallback?: string;
  options?: Array<{ value: string; labelFallback: string }>;
}

export interface TransportDescriptor {
  type: string;
  label: string;
  description: string;
  fields: FieldDescriptor[];
}

export interface DeliveryStats {
  pending: number;
  delivered: number;
  dead: number;
}

export interface KeyRef {
  id: string;
  name: string | null;
  deleted?: boolean;
}

export interface UsageSink {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  mode: "instant" | "window";
  windowSec: number | null;
  apiKeyIds: string[];
  filterKeys: KeyRef[];
  /** Redacted: a stored credential is the placeholder, never the value. */
  config: Record<string, unknown>;
  summary: string;
  enabled: boolean;
  nextWindowEnd: string | null;
  createdAt: string;
  deliveries: DeliveryStats;
}

export interface Delivery {
  id: string;
  kind: "event" | "window";
  status: "pending" | "sending" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  windowStart: string | null;
  windowEnd: string | null;
  keys: number;
  requests: number;
  cost: number;
  model: string | null;
}

export interface TestResult {
  valid: boolean;
  error?: string | null;
  latencyMs?: number | null;
  probe?: {
    method: string;
    url: string | null;
    status: number | null;
    statusText: string | null;
    bytes: number | null;
    durationMs: number | null;
    error: string | null;
  };
}

/** Sent back in place of a stored credential the operator did not retype. */
export const SECRET_PLACEHOLDER = "__stored__";

export const WINDOW_SIZES_SEC = [300, 900, 1800, 3600] as const;

export function errorText(payload: unknown, fallback: string): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const details = (error as { details?: Array<{ field: string; message: string }> } | undefined)
    ?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => `${detail.field}: ${detail.message}`).join(", ");
  }
  return fallback;
}
