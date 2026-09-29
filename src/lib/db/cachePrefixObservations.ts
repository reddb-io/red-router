/**
 * db/cachePrefixObservations.ts — persistence and summary of prompt-cache prefix diagnostics
 * (X-CACHE1). See src/lib/promptCache/prefixDiagnostics.ts for what an observation means.
 */

import { getDbInstance } from "./core";
import type { PrefixObservation } from "../promptCache/prefixDiagnostics";

const RETENTION_DAYS = 14;
const PRUNE_EVERY = 200;
let inserts = 0;

export interface CachePrefixRecordInput {
  observation: PrefixObservation;
  provider?: string | null;
  model?: string | null;
  connectionId?: string | null;
  apiKeyId?: string | null;
  timestamp?: string;
}

export function recordCachePrefixObservation(input: CachePrefixRecordInput): void {
  const db = getDbInstance();
  const { observation } = input;
  db.prepare(
    `INSERT INTO redrouter_cache_prefix_observations
       (timestamp, conversation_key, provider, model, connection_id, api_key_id, request_index,
        message_count, previous_message_count, stable_prefix_messages, first_divergent_index,
        cause, causes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.timestamp ?? new Date().toISOString(),
    observation.conversationKey,
    input.provider ?? null,
    input.model ?? null,
    input.connectionId ?? null,
    input.apiKeyId ?? null,
    observation.requestIndex,
    observation.messageCount,
    observation.previousMessageCount,
    observation.stablePrefixMessages,
    observation.firstDivergentIndex,
    observation.cause,
    JSON.stringify(observation.causes)
  );
  inserts += 1;
  if (inserts % PRUNE_EVERY === 0) pruneCachePrefixObservations();
}

export function pruneCachePrefixObservations(now = Date.now()): number {
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  return getDbInstance()
    .prepare("DELETE FROM redrouter_cache_prefix_observations WHERE timestamp < ?")
    .run(cutoff).changes;
}

interface CauseRow {
  cause: string;
  requests: number;
}

interface ModelRow {
  provider: string | null;
  model: string | null;
  requests: number;
  appended: number;
  rewritten: number;
  stable_ratio: number | null;
}

interface UsageRow {
  provider: string | null;
  model: string | null;
  requests: number;
  input: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

export interface CachePrefixSummary {
  since: string;
  days: number;
  /** Requests after the first of a conversation: the only ones a cache can help. */
  followUpRequests: number;
  byCause: { cause: string; requests: number }[];
  byModel: {
    provider: string | null;
    model: string | null;
    followUpRequests: number;
    /** Share of follow-up requests that only appended (cache should hold). */
    appendOnlyShare: number;
    /** Average share of the previous request's messages that stayed identical. */
    stablePrefixShare: number;
    tokensInput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    /** cache read ÷ total input (logged input already includes cached tokens). */
    cacheReadShare: number | null;
    /** cache written ÷ total input: a high value with a low read share means wasted writes. */
    cacheWriteShare: number | null;
  }[];
}

export function getCachePrefixSummary(options: { days?: number; now?: number } = {}): CachePrefixSummary {
  const days = Math.min(Math.max(Math.floor(options.days ?? 7), 1), RETENTION_DAYS);
  const since = new Date((options.now ?? Date.now()) - days * 86_400_000).toISOString();
  const db = getDbInstance();
  const causes = db
    .prepare(
      `SELECT cause, COUNT(*) AS requests FROM redrouter_cache_prefix_observations
        WHERE timestamp >= ? AND cause != 'first_request' GROUP BY cause ORDER BY requests DESC`
    )
    .all(since) as CauseRow[];
  const models = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS requests,
              SUM(CASE WHEN cause = 'none' THEN 1 ELSE 0 END) AS appended,
              SUM(CASE WHEN cause = 'none' THEN 0 ELSE 1 END) AS rewritten,
              AVG(CASE WHEN previous_message_count > 0
                       THEN stable_prefix_messages * 1.0 / previous_message_count END) AS stable_ratio
         FROM redrouter_cache_prefix_observations
        WHERE timestamp >= ? AND cause != 'first_request'
        GROUP BY provider, model ORDER BY requests DESC`
    )
    .all(since) as ModelRow[];
  const usage = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS requests, SUM(tokens_input) AS input,
              SUM(tokens_cache_read) AS cache_read, SUM(tokens_cache_creation) AS cache_write
         FROM usage_history WHERE timestamp >= ? GROUP BY provider, model`
    )
    .all(since) as UsageRow[];
  const usageOf = (provider: string | null, model: string | null) =>
    usage.find((row) => row.provider === provider && row.model === model);

  return {
    since,
    days,
    followUpRequests: causes.reduce((sum, row) => sum + row.requests, 0),
    byCause: causes.map((row) => ({ cause: row.cause, requests: row.requests })),
    byModel: models.map((row) => {
      const tokens = usageOf(row.provider, row.model);
      const input = Number(tokens?.input ?? 0);
      return {
        provider: row.provider,
        model: row.model,
        followUpRequests: row.requests,
        appendOnlyShare: row.requests ? row.appended / row.requests : 0,
        stablePrefixShare: Number(row.stable_ratio ?? 0),
        tokensInput: input,
        tokensCacheRead: Number(tokens?.cache_read ?? 0),
        tokensCacheWrite: Number(tokens?.cache_write ?? 0),
        cacheReadShare: input ? Number(tokens?.cache_read ?? 0) / input : null,
        cacheWriteShare: input ? Number(tokens?.cache_write ?? 0) / input : null,
      };
    }),
  };
}
