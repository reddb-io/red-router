import { createHash } from "node:crypto";
import { getIdempotencyKey, checkIdempotency } from "@/lib/idempotencyLayer";
import { calculateCost } from "@/lib/usage/costCalculator";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import {
  canonicalCacheValue,
  normalizeGenerationContract,
  outputContractOf,
} from "../../services/cache/generationContract.ts";
import type { EffectiveServiceTier } from "./serviceTier.ts";

type HeadersLike = Headers | Record<string, unknown> | null | undefined;
type IdempotencyRequest = { headers?: HeadersLike } | null | undefined;
type LoggerLike = { debug?: (...args: unknown[]) => void } | null | undefined;

const IDEMPOTENCY_SEMANTIC_FIELDS = [
  "messages",
  "input",
  "temperature",
  "top_p",
  "stream",
  "previous_response_id",
  "conversation",
  "prompt",
  "include",
  "truncation",
  "service_tier",
] as const;

function semanticRequestBody(body: unknown, legacyMessages: unknown): Record<string, unknown> {
  const request =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { messages: legacyMessages };
  return {
    ...Object.fromEntries(
      IDEMPOTENCY_SEMANTIC_FIELDS.filter((field) => request[field] !== undefined).map((field) => [
        field,
        request[field],
      ])
    ),
    generationContract: normalizeGenerationContract(outputContractOf(request)),
  };
}

/**
 * NEXA fusion-idempotency fix: compose the effective idempotency key from the raw
 * header key + API key identity + target provider/model + a semantic request digest.
 *
 * Why: combo-internal sub-requests (fusion panel members AND the judge) re-enter
 * chatCore SHARING the client's headers, so the raw `Idempotency-Key`/`x-request-id`
 * key was identical for all of them. A panel answer saved under the key and the
 * judge's check (~1ms later, inside the replay window) replayed it — the client
 * received a panel member's answer instead of the judge synthesis. Namespacing by
 * model separates panel members; the request digest separates the judge even when
 * it reuses a panel member's model (the judge body appends the judge directive
 * turn). API key identity is an unambiguous namespace outside the digest; different
 * users cannot replay each other's responses. A retry with the same identity,
 * model and generation contract still replays.
 */
export function composeIdempotencyKey({
  rawKey,
  provider,
  model,
  messages,
  body,
  apiKeyId,
}: {
  rawKey: string | null | undefined;
  provider: string;
  model: string;
  messages: unknown;
  body?: unknown;
  apiKeyId?: string | null;
}): string | null {
  if (!rawKey) return null;
  try {
    const digest = createHash("sha256")
      .update(JSON.stringify(canonicalCacheValue(semanticRequestBody(body, messages))))
      .digest("hex");
    // API key IDs are internal identifiers, never credentials or digest input.
    // A JSON tuple prevents raw header/provider delimiters from aliasing scopes.
    return JSON.stringify(["idempotency-v2", apiKeyId ?? null, rawKey, provider, model, digest]);
  } catch {
    // An unrepresentable body must miss, not share a fallback digest with other bodies.
    return null;
  }
}

/**
 * Resolve the request's idempotency key once and check the idempotency store. Returns the
 * resolved `idempotencyKey` alongside the cache `hit` so the caller can reuse the SAME key
 * for the later save path instead of re-deriving it — eliminating the dual-derivation that
 * the chatCore modularization (#3598) introduced. (#3821-review LEDGER-6)
 */
export async function checkIdempotencyCache({
  clientRawRequest,
  provider,
  model,
  body,
  effectiveServiceTier,
  startTime,
  log,
  videoTranscriptSensitive,
  apiKeyId,
}: {
  clientRawRequest: IdempotencyRequest;
  provider: string;
  model: string;
  body?: unknown;
  effectiveServiceTier: EffectiveServiceTier | null | undefined;
  startTime: number;
  log: LoggerLike;
  videoTranscriptSensitive?: boolean;
  apiKeyId?: string | null;
}): Promise<{ hit: { success: true; response: Response } | null; idempotencyKey: string | null }> {
  // A response may quote the video transcript. No key means neither a replay
  // from a previous entry nor a write at chatCore's later save site.
  if (videoTranscriptSensitive) return { hit: null, idempotencyKey: null };
  // NEXA fusion-idempotency fix: namespace the raw header key (see composeIdempotencyKey).
  const rawIdempotencyKey = getIdempotencyKey(clientRawRequest?.headers);
  const idempotencyKey = composeIdempotencyKey({
    rawKey: rawIdempotencyKey,
    provider,
    model,
    messages: (body as { messages?: unknown } | undefined)?.messages,
    body,
    apiKeyId,
  });
  const cachedIdemp = checkIdempotency(idempotencyKey);
  if (cachedIdemp) {
    log?.debug?.("IDEMPOTENCY", "Replayed completed request");
    const idempotentUsage =
      cachedIdemp.response && typeof cachedIdemp.response === "object"
        ? ((cachedIdemp.response as Record<string, unknown>).usage as
            Record<string, unknown> | undefined)
        : undefined;
    const idempotentCost = idempotentUsage
      ? await calculateCost(provider, model, idempotentUsage as Record<string, number>, {
          serviceTier: effectiveServiceTier,
        })
      : 0;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-OmniRoute-Idempotent": "true",
    };
    attachOmniRouteMetaHeaders(headers, {
      provider,
      model,
      cacheHit: false,
      latencyMs: Date.now() - startTime,
      usage: idempotentUsage,
      costUsd: idempotentCost,
    });
    return {
      idempotencyKey,
      hit: {
        success: true,
        response: new Response(JSON.stringify(cachedIdemp.response), {
          status: cachedIdemp.status,
          headers,
        }),
      },
    };
  }
  return { hit: null, idempotencyKey };
}
