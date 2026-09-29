/**
 * Prompt-cache prefix observation for one upstream request (X-CACHE1).
 *
 * Compares the body that is actually sent upstream with the previous request of the same
 * conversation and records where the cacheable prefix diverged. It never throws and never touches
 * the request: diagnostics must not be able to fail a chat. Disable with REDROUTER_CACHE_DIAGNOSTICS=0.
 */

import {
  conversationKeyOf,
  messagesOf,
  observePrefix,
} from "@/lib/promptCache/prefixDiagnostics";
import { recordCachePrefixObservation } from "@/lib/db/cachePrefixObservations";

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

export function observeUpstreamPrefix(args: {
  /** The request as the client sent it: conversation identity must not depend on our rewrites. */
  clientBody: unknown;
  /** The body sent to the provider. */
  finalBody: unknown;
  apiKeyId?: string | null;
  provider?: string | null;
  model?: string | null;
  connectionId?: string | null;
  log?: { debug?: (...args: unknown[]) => void } | null;
}): void {
  try {
    if (process.env.REDROUTER_CACHE_DIAGNOSTICS === "0") return;
    const finalBody = asRecord(args.finalBody);
    if (messagesOf(finalBody).length === 0) return;
    const observation = observePrefix({
      conversationKey: conversationKeyOf({
        body: asRecord(args.clientBody),
        apiKeyId: args.apiKeyId,
        provider: args.provider,
        model: args.model,
      }),
      body: finalBody,
      connectionId: args.connectionId,
    });
    recordCachePrefixObservation({
      observation,
      provider: args.provider,
      model: args.model,
      connectionId: args.connectionId,
      apiKeyId: args.apiKeyId,
    });
    if (observation.cause !== "none" && observation.cause !== "first_request") {
      args.log?.debug?.(
        "CACHE",
        `prefix diverged (${observation.causes.join(",")}) at message ${observation.firstDivergentIndex}` +
          ` of ${observation.messageCount}; ${observation.stablePrefixMessages} kept`
      );
    }
  } catch {
    // Diagnostics only.
  }
}
