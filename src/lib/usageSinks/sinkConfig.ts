/**
 * Turning API input into a stored sink config, and a stored sink into an API view.
 *
 * Credential handling reuses log export's primitives (`src/lib/logExport/secrets.ts`): on edit the
 * stored ciphertext is kept wherever the caller sends back the placeholder (or omits the field),
 * new plaintext is validated and then encrypted field by field, writes are refused when no
 * STORAGE_ENCRYPTION_KEY is configured, and responses carry the placeholder instead of the value.
 */
import type { UsageDeliveryStats } from "./types";
import type { UsageSink } from "@/lib/db/usageSinks";
import {
  decryptSecretFields,
  encryptSecretFields,
  fieldsRequireEncryptionKey,
  mergeSecretFields,
  redactSecretFields,
  SECRET_PLACEHOLDER,
} from "@/lib/logExport/secrets";
import { getTransport } from "./transports";

// A flat shape rather than a discriminated union: this project compiles without strictNullChecks,
// where `if (!result.ok)` does not narrow. `stored` is set when `ok`, `error` when not.
export interface ResolvedConfig {
  ok: boolean;
  stored?: Record<string, unknown>;
  error?: string;
}

/**
 * Validate `incoming` for `type`, merged over `storedEncrypted` when editing, and return the
 * config to persist (credentials encrypted). Never throws.
 */
export function resolveSinkConfig(
  type: string,
  incoming: Record<string, unknown>,
  storedEncrypted: Record<string, unknown> = {}
): ResolvedConfig {
  const transport = getTransport(type);
  if (!transport) return { ok: false, error: `Unknown sink type "${type}"` };
  const merged = mergeSecretFields(
    transport.secretFields,
    decryptSecretFields(transport.secretFields, storedEncrypted),
    incoming
  );
  const parsed = transport.configSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid ${transport.label} configuration (${detail})` };
  }
  const plain = parsed.data as Record<string, unknown>;
  if (fieldsRequireEncryptionKey(transport.secretFields, plain)) {
    return {
      ok: false,
      error:
        "STORAGE_ENCRYPTION_KEY is required: usage sinks store credentials, and without it they " +
        "would be written to SQLite in plaintext",
    };
  }
  return { ok: true, stored: encryptSecretFields(transport.secretFields, plain) };
}

/** A sink as the API returns it: credentials are never sent back, only the placeholder. */
export function usageSinkView(sink: UsageSink, stats?: UsageDeliveryStats) {
  const transport = getTransport(sink.type);
  const config = transport ? redactSecretFields(transport.secretFields, sink.config) : {};
  return {
    id: sink.id,
    name: sink.name,
    type: sink.type,
    typeLabel: transport?.label ?? sink.type,
    mode: sink.mode,
    windowSec: sink.windowSec,
    apiKeyIds: sink.apiKeyIds,
    config,
    summary: transport ? transport.summary(sink.config) : "",
    // The original webhook-only fields, kept for existing API clients.
    ...(sink.type === "webhook" ? { url: sink.url, secret: SECRET_PLACEHOLDER } : {}),
    enabled: sink.enabled,
    cursorId: sink.cursorId,
    nextWindowEnd: sink.nextWindowEnd,
    createdAt: sink.createdAt,
    updatedAt: sink.updatedAt,
    source: "request_cost_ledger",
    coverage: "costed-requests-only",
    ...(stats ? { deliveries: stats } : {}),
  };
}
