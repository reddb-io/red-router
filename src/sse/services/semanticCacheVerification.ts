import { getCacheVerificationOptions } from "@/lib/cache/verificationOptions";
import {
  getApiKeyById,
  getApiKeyMetadata,
  isModelAllowedForKey,
  validateApiKey,
} from "@/lib/db/apiKeys";
import { resolveQuotaKeyScope } from "@/lib/quota/quotaKey";
import { getRequestBudgetScope, type RequestAttribution } from "@/lib/usage/attribution";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";
import { resolveSystemOneTarget } from "@omniroute/open-sse/handlers/systemOneCore.ts";
import type { SemanticCacheConfig } from "@omniroute/open-sse/config/semanticCacheConfig.ts";
import {
  CACHE_REUSE_QUESTIONS,
  readReuseProbability,
  type SemanticVerificationInput,
  type SemanticVerificationResult,
} from "@omniroute/open-sse/services/cache/semanticVerification.ts";
import { normalizeUsage } from "@omniroute/open-sse/utils/usageTracking.ts";
import { restrictJevConnections } from "@omniroute/open-sse/services/combo/jevConfig.ts";
import { extractApiKey } from "./auth";
import { dispatchSystemOne } from "./systemOneDispatch";

const defaults = {
  options: getCacheVerificationOptions,
  key: getApiKeyById,
  metadata: getApiKeyMetadata,
  valid: validateApiKey,
  modelAllowed: isModelAllowedForKey,
  quota: resolveQuotaKeyScope,
  dispatch: dispatchSystemOne,
  cost: calculateCostDetailed,
};

/** Same credential, budget and accounting path as public System One; never a chat completion. */
export async function verifySemanticCacheCandidate(
  input: SemanticVerificationInput,
  config: SemanticCacheConfig,
  request: {
    apiKeyId?: string | null;
    signal?: AbortSignal;
    headers?: unknown;
    attribution?: RequestAttribution | null;
  },
  signal: AbortSignal,
  overrides: Partial<typeof defaults> = {}
): Promise<SemanticVerificationResult> {
  const deps = { ...defaults, ...overrides };
  const unavailable: SemanticVerificationResult = { outcome: "unavailable", evaluationCostUsd: 0 };
  if (!config.verificationEnabled || signal.aborted) return unavailable;
  try {
    const connection = (await deps.options()).find(
      (item) => item.id === config.verificationConnectionId
    );
    if (!connection?.models.some((model) => model.id === config.verificationModel))
      return unavailable;
    const target = resolveSystemOneTarget(config.verificationModel);
    if (!target || target.provider !== connection.provider) return unavailable;
    let allowedConnections: string[] | null = null;
    let apiKeyName: string | null = null;
    if (request.apiKeyId) {
      const headers = request.headers ? new Headers(request.headers as HeadersInit) : new Headers();
      const rawKey = extractApiKey({ headers });
      const stored = rawKey ? null : await deps.key(request.apiKeyId);
      const clientKey = rawKey || stored?.key;
      if (!clientKey || !(await deps.valid(clientKey))) return unavailable;
      const metadata = await deps.metadata(clientKey);
      if (
        !metadata ||
        metadata.id !== request.apiKeyId ||
        !metadata.isActive ||
        metadata.isBanned ||
        !(await deps.modelAllowed(clientKey, config.verificationModel))
      )
        return unavailable;
      // This evaluator is an auxiliary operation inside an authorized chat request.
      // A key explicitly restricted away from decisions must not pay for it.
      if (metadata.allowedEndpoints?.length && !metadata.allowedEndpoints.includes("decisions"))
        return unavailable;
      allowedConnections = metadata.allowedConnections?.length ? metadata.allowedConnections : null;
      if (metadata.allowedQuotas?.length) {
        const quota = await deps.quota(metadata.allowedQuotas);
        allowedConnections = restrictJevConnections(allowedConnections, quota.connectionIds);
      }
      if (allowedConnections && !allowedConnections.includes(connection.id)) return unavailable;
      apiKeyName = metadata.name;
    }
    const result = await deps.dispatch(
      target,
      { state: input.state, questions: CACHE_REUSE_QUESTIONS },
      {
        allowedConnections,
        forcedConnectionId: connection.id,
        apiKeyId: request.apiKeyId,
        apiKeyName,
        attribution: request.attribution ?? getRequestBudgetScope(request.signal)?.attribution,
        signal,
        timeoutMs: config.verificationTimeoutMs,
      }
    );
    // Failures can be unmetered by upstream. Never report an unknown cost as zero.
    if (!result.response.ok) return { outcome: "unavailable" };
    const payload = await result.response.json();
    const probability = readReuseProbability(payload);
    let evaluationCostUsd: number | undefined;
    let avoidedCostEstimateUsd: number | undefined;
    const usage = normalizeUsage(payload.usage);
    if (usage) {
      const cost = await deps.cost(target.provider, target.model, usage);
      if (cost.priced) evaluationCostUsd = cost.costUsd;
    }
    const cachedUsage = normalizeUsage(input.entry.response.usage as Record<string, unknown>);
    if (cachedUsage) {
      const cost = await deps.cost(input.entry.provider, input.entry.model, cachedUsage);
      if (cost.priced) avoidedCostEstimateUsd = cost.costUsd;
    }
    return {
      outcome:
        !result.accountingSucceeded || signal.aborted || probability === null
          ? "unavailable"
          : probability >= config.verificationMinProbability
            ? "accepted"
            : "rejected",
      evaluationCostUsd,
      avoidedCostEstimateUsd,
    };
  } catch {
    return { outcome: "unavailable" };
  }
}
