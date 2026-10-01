import type { SemanticVerificationResult } from "./semanticVerification.ts";

const since = new Date().toISOString();
const stats = {
  accepted: 0,
  rejected: 0,
  unavailable: 0,
  skipped: 0,
  totalLatencyMs: 0,
  knownEvaluationCostUsd: 0,
  unpricedEvaluations: 0,
  avoidedCostEstimateUsd: 0,
};

export function recordCacheVerification(
  result: SemanticVerificationResult,
  latencyMs: number
): void {
  stats[result.outcome]++;
  stats.totalLatencyMs += Math.max(0, latencyMs);
  if (
    typeof result.evaluationCostUsd === "number" &&
    Number.isFinite(result.evaluationCostUsd) &&
    result.evaluationCostUsd >= 0
  ) {
    stats.knownEvaluationCostUsd += result.evaluationCostUsd;
  } else {
    stats.unpricedEvaluations++;
  }
  if (
    result.outcome === "accepted" &&
    typeof result.avoidedCostEstimateUsd === "number" &&
    Number.isFinite(result.avoidedCostEstimateUsd) &&
    result.avoidedCostEstimateUsd >= 0
  ) {
    stats.avoidedCostEstimateUsd += result.avoidedCostEstimateUsd;
  }
}
export function recordSkippedCacheVerification(): void {
  stats.skipped++;
}
export function getCacheVerificationStats() {
  const evaluations = stats.accepted + stats.rejected + stats.unavailable;
  return {
    ...stats,
    since,
    scope: "process",
    evaluations,
    averageLatencyMs: evaluations ? stats.totalLatencyMs / evaluations : 0,
  };
}
