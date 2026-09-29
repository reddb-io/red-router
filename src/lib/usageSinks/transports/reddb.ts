/**
 * RedDB queue: `QUEUE PUSH <queue> <json> DEDUP '<delivery id>'` sent to RedDB's HTTP query
 * endpoint (`POST /query`, optional Bearer token), the statement `@reddb-io/client` builds for
 * `db.queue.push`. DEDUP makes a retried delivery a no-op while it is inside the queue's dedup
 * window (5 minutes by default, `DEDUP_WINDOW` on CREATE/ALTER QUEUE), so the delivery id is the
 * message identity. Create the queue once, e.g.
 *   CREATE QUEUE IF NOT EXISTS usage_events WITH DEDUP_WINDOW 1h
 *
 * Egress: the URL goes through the shared outbound guard (cloud metadata always refused,
 * private/local addresses only with the private-provider-URL opt-in) and the DNS-pinned,
 * no-redirect guarded fetch.
 */
import { z } from "zod";
import {
  blankResult,
  createGuardedFetch,
  describeSendError,
  displayUrl,
  egressUrlIssue,
  permanentFailure,
  readResponse,
  remoteDetail,
} from "./http";
import type { DeliveryResult, UsageSinkTransport } from "./types";

/** RedDB parses at most 1 MiB of statement text by default. */
export const REDDB_MAX_STATEMENT_BYTES = 1024 * 1024;
export const QUEUE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface RedDbConfig {
  url: string;
  queue: string;
  token?: string;
  tenant?: string;
}

/** The statement that enqueues one payload (the queue name is validated, the id is quoted). */
export function queuePushStatement(
  queue: string,
  payload: Record<string, unknown>,
  dedupId: string
): string {
  return `QUEUE PUSH ${queue} ${JSON.stringify(payload)} DEDUP '${String(dedupId).replace(/'/g, "''")}'`;
}

export const queryEndpoint = (url: string): string =>
  `${String(url || "").replace(/\/+$/, "")}/query`;

const redDbConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .superRefine((value, ctx) => {
      const issue = egressUrlIssue(value, ["https:", "http:"]);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    })
    .transform((value) => value.replace(/\/+$/, "")),
  queue: z
    .string()
    .trim()
    .regex(QUEUE_NAME, "Use letters, digits and _, not starting with a digit"),
  token: z.string().max(2048).optional(),
  tenant: z.string().trim().max(128).optional(),
});

export const redDbTransport: UsageSinkTransport<RedDbConfig> = {
  type: "reddb",
  label: "RedDB queue",
  description:
    "QUEUE PUSH with the delivery id as the DEDUP key, so a retried delivery is not enqueued twice.",
  secretFields: ["token"],
  fields: [
    {
      key: "url",
      labelFallback: "RedDB URL",
      type: "text",
      required: true,
      placeholder: "http://127.0.0.1:5000",
    },
    {
      key: "queue",
      labelFallback: "Queue",
      type: "text",
      required: true,
      placeholder: "usage_events",
      helpFallback: "Create it once: CREATE QUEUE IF NOT EXISTS usage_events WITH DEDUP_WINDOW 1h",
    },
    {
      key: "token",
      labelFallback: "Token (optional)",
      type: "password",
      secret: true,
      placeholder: "rdb_k_...",
      helpFallback: "Not needed for a RedDB started without --auth.",
    },
    { key: "tenant", labelFallback: "Tenant (optional)", type: "text" },
  ],
  configSchema: redDbConfigSchema as unknown as z.ZodType<RedDbConfig>,
  summary: (config) =>
    `QUEUE ${config.queue || "?"} @ ${String(config.url || "").replace(/^https?:\/\//, "")}`,

  async send({ config, id, payload }, deps = {}): Promise<DeliveryResult> {
    const endpoint = config.url ? queryEndpoint(config.url) : null;
    const target = displayUrl(endpoint);
    if (!endpoint || !QUEUE_NAME.test(config.queue || "")) {
      return permanentFailure(target, "A RedDB URL and queue name are required");
    }
    const query = queuePushStatement(config.queue, payload, id);
    const size = Buffer.byteLength(query);
    if (size > REDDB_MAX_STATEMENT_BYTES) {
      return permanentFailure(
        target,
        `Payload too large for one RedDB statement (${size} bytes, limit ${REDDB_MAX_STATEMENT_BYTES})`
      );
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "RedRouter-UsageSinks/1",
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    if (config.tenant) headers["x-reddb-tenant"] = config.tenant;

    const httpFetch = deps.httpFetch ?? createGuardedFetch();
    const started = Date.now();
    try {
      const response = await httpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      });
      const { result, text } = await readResponse(response, blankResult(target), started);
      let parsed: { ok?: boolean; error?: unknown } | null = null;
      try {
        parsed = JSON.parse(text) as { ok?: boolean; error?: unknown };
      } catch {
        // Not JSON.
      }
      if (response.ok && parsed?.ok !== false) return { ...result, ok: true };
      const detail = parsed?.error ? remoteDetail(String(parsed.error)) : remoteDetail(text);
      return { ...result, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
    } catch (error) {
      return {
        ...blankResult(target),
        durationMs: Date.now() - started,
        error: describeSendError(error),
      };
    }
  },
};
