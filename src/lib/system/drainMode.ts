/**
 * Operator-initiated drain (rolling restart / load-balancer rotation).
 *
 * Distinct from the SIGTERM shutdown drain in `gracefulShutdown.ts`, which rejects every
 * /api/ request because the process is about to exit. A manual drain only turns away NEW
 * client API traffic (the OpenAI/Anthropic-style entry points) and flips `/readyz` to 503
 * `draining`, while management routes (including the DELETE that lifts it), in-flight
 * requests and streams keep running. The flag is process-local and gone after a restart.
 */

declare global {
  var __redrouterManualDrain: { since: string } | undefined;
}

export interface ManualDrainState {
  draining: boolean;
  since: string | null;
}

export function startManualDrain(now: Date = new Date()): ManualDrainState {
  // Idempotent: a second POST keeps the original timestamp.
  globalThis.__redrouterManualDrain ??= { since: now.toISOString() };
  return getManualDrainState();
}

export function stopManualDrain(): ManualDrainState {
  globalThis.__redrouterManualDrain = undefined;
  return getManualDrainState();
}

export function isManualDrainActive(): boolean {
  return globalThis.__redrouterManualDrain !== undefined;
}

export function getManualDrainState(): ManualDrainState {
  const state = globalThis.__redrouterManualDrain;
  return { draining: state !== undefined, since: state?.since ?? null };
}

/**
 * True when a request must be turned away by the manual drain: a mutating call on the
 * client API surface (chat, responses, embeddings...). Reads such as GET /v1/models stay up.
 */
export function shouldRejectForManualDrain(routeClass: string, method: string): boolean {
  if (!isManualDrainActive()) return false;
  if (routeClass !== "CLIENT_API") return false;
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/** Retry hint for clients while the node is draining. */
export const MANUAL_DRAIN_RETRY_AFTER_SECONDS = 5;
