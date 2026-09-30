/**
 * OTLP/HTTP JSON log-export destination.
 *
 * Ships call logs to any OpenTelemetry collector or backend that accepts OTLP logs
 * (`POST {endpoint}/v1/logs`, `Content-Type: application/json`). One call log becomes one
 * log record. Only metadata leaves RedRouter: provider, model, status, latency, token
 * counts, cost and the request id. Prompt and response bodies are never read from the
 * record, whatever the destination's `includeBodies` setting says.
 *
 * Delivery is at least once. OTLP has no insert-id, so a batch whose later chunk failed is
 * re-sent from the last confirmed cursor on the next run (the runner only advances the
 * cursor after `send()` resolves).
 *
 * Egress goes through the shared usage-sink guard (`createGuardedFetch`): DNS is resolved
 * and pinned, cloud-metadata and (without the operator opt-in) private addresses are
 * refused, redirects are not followed, and every request has a 10 s timeout.
 *
 * Trace export is out of scope: the runner ships flat call-log rows, not spans.
 */

import { z } from "zod";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import {
  createGuardedFetch,
  describeSendError,
  egressUrlIssue,
  remoteDetail,
} from "@/lib/usageSinks/transports/http";
import type { HttpFetch } from "@/lib/usageSinks/transports/types";
import type {
  LogExportClient,
  LogExportConfigField,
  LogExportDestinationType,
  LogExportRecord,
  LogExportTestResult,
} from "../types";

/** Log records per HTTP request. Keeps a request in the low hundreds of KB. */
export const OTLP_CHUNK_SIZE = 500;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_HEADERS = 20;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Headers the exporter sets itself; an operator value would break the request. */
const RESERVED_HEADERS = new Set(["content-type", "content-length", "host", "connection"]);
const LOG_PATH = "/v1/logs";

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || IPV4_LOOPBACK.test(host);
}

/** Why an endpoint is refused, or null. https always; plain http only for loopback. */
function endpointIssue(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Must be a valid URL";
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "Must use HTTPS (plain HTTP is only allowed for a loopback collector)";
  }
  return egressUrlIssue(value, ["https:", "http:"]);
}

/** `Name: value` per line -> header map. Returns an error message for a bad line. */
export function parseOtlpHeaders(raw: string): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_HEADERS) return { headers, error: `At most ${MAX_HEADERS} headers` };
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) return { headers, error: "Each header must be written as Name: value" };
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME.test(name)) return { headers, error: "A header name is not valid" };
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return { headers, error: `${name} is set by the exporter and cannot be overridden` };
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      return { headers, error: "A header value contains control characters" };
    }
    headers[name] = value;
  }
  return { headers };
}

export const otlpConfigSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .superRefine((value, ctx) => {
      const issue = endpointIssue(value);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    }),
  headers: z
    .string()
    .max(8192)
    .superRefine((value, ctx) => {
      const { error } = parseOtlpHeaders(value);
      if (error) ctx.addIssue({ code: "custom", message: error });
    })
    .default(""),
  serviceName: z.string().trim().min(1).max(128).default("red-router"),
  /**
   * The endpoint is the complete logs URL: post to it exactly as written, without appending
   * `/v1/logs`. For vendors whose OTLP path differs from the standard one.
   */
  endpointIsFull: z.boolean().optional(),
});

export type OtlpConfig = z.infer<typeof otlpConfigSchema>;

const FIELDS: readonly LogExportConfigField[] = [
  {
    key: "endpoint",
    labelFallback: "OTLP endpoint",
    type: "text",
    required: true,
    placeholder: "https://otel-collector.example.com:4318",
    helpFallback:
      "Base URL of an OTLP/HTTP receiver; /v1/logs is appended. HTTPS only, except a loopback collector.",
  },
  {
    key: "headers",
    labelFallback: "Request headers",
    type: "textarea",
    secret: true,
    placeholder: "Authorization: Bearer <token>",
    helpFallback:
      "One Name: value per line, for collector authentication. Stored encrypted, never returned.",
  },
  {
    key: "serviceName",
    labelFallback: "Service name",
    type: "text",
    placeholder: "red-router",
    helpFallback: "Reported as the service.name resource attribute.",
  },
  {
    key: "endpointIsFull",
    labelFallback: "Endpoint is the full logs URL",
    type: "boolean",
    defaultValue: false,
    helpFallback:
      "Post to the endpoint exactly as written instead of appending /v1/logs. Leave off for a standard OTLP/HTTP receiver.",
  },
];

// --- OTLP JSON body ------------------------------------------------------------------------

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
}

export interface OtlpLogsRequest {
  resourceLogs: Array<{
    resource: { attributes: KeyValue[] };
    scopeLogs: Array<{ scope: { name: string; version: string }; logRecords: OtlpLogRecord[] }>;
  }>;
}

/** OTLP severity numbers: INFO=9, WARN=13, ERROR=17, UNSPECIFIED=0. */
export function severityForStatus(status: number | null): { number: number; text: string } {
  if (status === null || !Number.isFinite(status)) return { number: 0, text: "UNSPECIFIED" };
  if (status >= 500) return { number: 17, text: "ERROR" };
  if (status >= 400) return { number: 13, text: "WARN" };
  return { number: 9, text: "INFO" };
}

/** ISO timestamp -> nanoseconds since the epoch, as the decimal string OTLP JSON requires. */
export function toUnixNano(iso: string | null, fallbackMs: number): string {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  const ms = Number.isFinite(parsed) ? parsed : fallbackMs;
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

const str = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): KeyValue => ({
  key,
  value: { intValue: String(Math.trunc(value)) },
});
const dbl = (key: string, value: number): KeyValue => ({ key, value: { doubleValue: value } });

/** Attributes for one call log. Null fields are omitted. Never reads any body field. */
export function toAttributes(record: LogExportRecord): KeyValue[] {
  const attributes: KeyValue[] = [];
  if (record.provider) attributes.push(str("provider", record.provider));
  if (record.model) attributes.push(str("model", record.model));
  if (record.status !== null) attributes.push(int("status", record.status));
  if (record.duration !== null) attributes.push(int("latency_ms", record.duration));
  if (record.tokensIn !== null) attributes.push(int("tokens_in", record.tokensIn));
  if (record.tokensOut !== null) attributes.push(int("tokens_out", record.tokensOut));
  if (record.tokensIn !== null || record.tokensOut !== null) {
    attributes.push(int("tokens", (record.tokensIn ?? 0) + (record.tokensOut ?? 0)));
  }
  if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd)) {
    attributes.push(dbl("cost_usd", record.costUsd));
  }
  attributes.push(str("request_id", record.id));
  return attributes;
}

export function buildOtlpLogsRequest(
  records: readonly LogExportRecord[],
  options: { serviceName: string; nowMs?: number }
): OtlpLogsRequest {
  const nowMs = options.nowMs ?? Date.now();
  const observed = toUnixNano(null, nowMs);
  const logRecords: OtlpLogRecord[] = records.map((record) => {
    const severity = severityForStatus(record.status);
    return {
      timeUnixNano: toUnixNano(record.timestamp, nowMs),
      observedTimeUnixNano: observed,
      severityNumber: severity.number,
      severityText: severity.text,
      // A fixed marker, not the path or any payload: the detail lives in the attributes.
      body: { stringValue: "call_log" },
      attributes: toAttributes(record),
    };
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            str("service.name", options.serviceName),
            str("service.version", APP_CONFIG.version),
          ],
        },
        scopeLogs: [
          { scope: { name: "red-router.call-logs", version: APP_CONFIG.version }, logRecords },
        ],
      },
    ],
  };
}

// --- client --------------------------------------------------------------------------------

/** `endpointIsFull` keeps the endpoint as written; otherwise `/v1/logs` is appended once. */
export function otlpLogsUrl(endpoint: string, endpointIsFull = false): string {
  const trimmed = endpoint.trim();
  if (endpointIsFull) return trimmed;
  const base = trimmed.replace(/\/+$/, "");
  return base.endsWith(LOG_PATH) ? base : `${base}${LOG_PATH}`;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

class OtlpClient implements LogExportClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    private readonly config: OtlpConfig,
    private readonly httpFetch: HttpFetch = createGuardedFetch(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.url = otlpLogsUrl(config.endpoint, config.endpointIsFull);
    this.headers = {
      ...parseOtlpHeaders(config.headers).headers,
      "Content-Type": "application/json",
    };
  }

  private post(body: OtlpLogsRequest): Promise<Response> {
    return this.httpFetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  async test(): Promise<LogExportTestResult> {
    try {
      const response = await this.post(
        buildOtlpLogsRequest([], { serviceName: this.config.serviceName })
      );
      if (response.ok) {
        return {
          ok: true,
          detail: `Collector accepted an empty export (HTTP ${response.status}).`,
        };
      }
      const text = await response.text().catch(() => "");
      const detail = remoteDetail(text);
      return {
        ok: false,
        detail: `Collector answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return { ok: false, detail: describeSendError(error) };
    }
  }

  async prepare(): Promise<void> {
    // OTLP receivers need no setup.
  }

  async send(records: readonly LogExportRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += OTLP_CHUNK_SIZE) {
      await this.sendChunk(records.slice(i, i + OTLP_CHUNK_SIZE));
    }
  }

  private async sendChunk(chunk: readonly LogExportRecord[]): Promise<void> {
    const body = buildOtlpLogsRequest(chunk, { serviceName: this.config.serviceName });
    for (let attempt = 1; ; attempt++) {
      let response: Response | null = null;
      try {
        response = await this.post(body);
      } catch (error) {
        // A blocked or timed-out destination surfaces as a failure; only transport-level
        // errors are worth another attempt inside the same run.
        if (attempt >= MAX_ATTEMPTS || describeSendError(error).startsWith("Destination blocked")) {
          throw new Error(describeSendError(error));
        }
        await this.sleep(retryDelayMs(null, attempt));
        continue;
      }

      if (response.ok) {
        await this.warnOnPartialSuccess(response, chunk.length);
        return;
      }
      const retryable = RETRYABLE_STATUSES.has(response.status);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const detail = remoteDetail(await response.text().catch(() => ""));
        throw new Error(
          `OTLP collector answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }
      await this.sleep(retryDelayMs(response, attempt));
    }
  }

  /**
   * OTLP reports rejected records as HTTP 200 with `partialSuccess`. The spec says not to
   * retry those, and throwing would strand the cursor on a batch the collector will always
   * refuse, so it is logged and the batch counts as delivered.
   */
  private async warnOnPartialSuccess(response: Response, sent: number): Promise<void> {
    try {
      const parsed = (await response.json()) as {
        partialSuccess?: { rejectedLogRecords?: number | string };
      };
      const rejected = Number(parsed?.partialSuccess?.rejectedLogRecords ?? 0);
      if (rejected > 0) {
        console.warn(`[LogExport] OTLP collector rejected ${rejected} of ${sent} log records.`);
      }
    } catch {
      /* empty or non-JSON success body */
    }
  }
}

export const otlpDestination: LogExportDestinationType<OtlpConfig> = {
  id: "otlp",
  labelFallback: "OpenTelemetry (OTLP logs)",
  descriptionFallback:
    "Send call-log metadata (provider, model, status, latency, tokens, cost, request id) to an OTLP/HTTP collector as log records. Prompt and response bodies are never sent.",
  docsUrl: "https://opentelemetry.io/docs/specs/otlp/#otlphttp",
  secretFields: ["headers"],
  fields: FIELDS,
  configSchema: otlpConfigSchema,
  needsCost: true,
  createClient: (config) => new OtlpClient(config),
};

/** Test seam: build a client over an injected fetch and sleep. */
export function createOtlpClientForTest(
  config: OtlpConfig,
  httpFetch: HttpFetch,
  sleep: (ms: number) => Promise<void> = async () => {}
): LogExportClient {
  return new OtlpClient(config, httpFetch, sleep);
}
