import {
  JEV_DEFAULT_CRITERIA,
  JEV_DEFAULT_INSTRUCTIONS,
  JEV_MIN_CONFIDENCE,
  JEV_STATE_CHAR_BUDGET,
  JEV_TIMEOUT_MS,
  JEV_TIERS,
} from "@omniroute/open-sse/config/jev.ts";
import {
  forwardSystemOne,
  resolveSystemOneTarget,
} from "@omniroute/open-sse/handlers/systemOneCore.ts";
import { buildState, type JevState } from "@omniroute/open-sse/decision/state.ts";
import {
  buildModelQuestions,
  buildToolQuestions,
  shortlistTools,
} from "@omniroute/open-sse/decision/questions.ts";
import {
  resolveModelDecision,
  resolveToolDecision,
  type ToolDecisionResult,
} from "@omniroute/open-sse/decision/decide.ts";
import { normalizeAnswers } from "@omniroute/open-sse/decision/jev.ts";
import { resolveCriteria } from "@omniroute/open-sse/decision/modelBriefs.ts";
import { isEncryptedTask } from "@omniroute/open-sse/decision/signals.ts";
import {
  extractTools,
  hasPinnedToolChoice,
  UNSUPPORTED_EXECUTORS,
} from "@omniroute/open-sse/decision/tools.ts";
import type { ComplexityTier } from "@omniroute/open-sse/services/autoCombo/complexityRouter.ts";
import type { JevRoutingConfig } from "@omniroute/open-sse/services/combo/jevConfig.ts";
import type { AutoProviderCandidate } from "@omniroute/open-sse/services/combo/types.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { hasBlockingProxyAssignment } from "@/lib/db/proxies";
import { getProviderCredentialsWithQuotaPreflight } from "@/sse/services/auth";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { saveRequestUsage } from "@/lib/usage/usageHistory";

type JevTier = (typeof JEV_TIERS)[number];
type JevModelCandidate = Pick<AutoProviderCandidate, "provider" | "model" | "costPer1MTokens">;
type JevLog = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
type JevEvaluationOptions = {
  allowedConnections?: string[] | null;
  apiKeyId?: string | null;
  signal?: AbortSignal | null;
};

type UsableDecisionCredentials = {
  connectionId: string;
  apiKey?: string | null;
  accessToken?: string | null;
  authType?: string | null;
};

export function hasUsableDecisionConnection(value: unknown): value is UsableDecisionCredentials {
  if (!value || typeof value !== "object") return false;
  const credentials = value as {
    connectionId?: unknown;
    allExpired?: unknown;
    allRateLimited?: unknown;
  };
  return (
    typeof credentials.connectionId === "string" &&
    credentials.connectionId.length > 0 &&
    credentials.allExpired !== true &&
    credentials.allRateLimited !== true
  );
}

export function isDecisionConnectionAllowed(
  connectionId: string,
  allowedConnections: string[] | null | undefined
): boolean {
  return allowedConnections == null || allowedConnections.includes(connectionId);
}

export function readJevTier(payload: unknown): JevTier | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const answer = (answers as { tier?: unknown }).tier;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const choice = (answer as { choice?: unknown }).choice;
  if (typeof choice !== "string" || !JEV_TIERS.includes(choice as JevTier)) return null;
  const probabilities = (answer as { probabilities?: unknown }).probabilities;
  const winningProbability =
    probabilities && typeof probabilities === "object" && !Array.isArray(probabilities)
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined;
  const confidence = (answer as { confidence?: unknown }).confidence ?? winningProbability;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  if (confidence < JEV_MIN_CONFIDENCE || confidence > 1) return null;
  return choice as JevTier;
}

export function jevTierToMinimum(tier: JevTier): ComplexityTier {
  if (tier === "SIMPLE") return "free";
  if (tier === "MEDIUM") return "cheap";
  return "premium";
}

/** The evaluator may see only models the combo can route, within the request's cost cap. */
export function buildJevModelPool(
  candidates: JevModelCandidate[],
  budgetCap: number | null | undefined,
  estimatedInputTokens: number
): Array<JevModelCandidate & { id: string }> {
  const tokens =
    Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0 ? estimatedInputTokens : 1000;
  const pool = new Map<string, JevModelCandidate & { id: string }>();
  for (const candidate of candidates) {
    if (!candidate.provider || !candidate.model) continue;
    const price = candidate.costPer1MTokens;
    if (budgetCap && (!Number.isFinite(price) || (price * tokens) / 1_000_000 > budgetCap))
      continue;
    const id = `${candidate.provider}/${candidate.model}`;
    if (!pool.has(id)) pool.set(id, { ...candidate, id });
  }
  return [...pool.values()];
}

/** A verdict outside the authorized pool or below the model gate never changes routing. */
export function readJevModelChoice(
  payload: unknown,
  pool: Array<JevModelCandidate & { id: string }>
): string | null {
  if (!payload || typeof payload !== "object" || pool.length < 2) return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const normalized = normalizeAnswers(answers as Record<string, unknown>);
  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));
  const verdict = resolveModelDecision({
    answers: normalized,
    models: [...byId.keys()],
    priceOf: (id) => {
      const price = byId.get(id)?.costPer1MTokens;
      return typeof price === "number" && Number.isFinite(price) ? price : null;
    },
  });
  return verdict.apply && verdict.model && byId.has(verdict.model) ? verdict.model : null;
}

/** The successful upstream evaluation is never repeated because local usage persistence failed. */
async function askJevFromStoredConnection(
  config: JevRoutingConfig,
  state: JevState,
  questions: Record<string, unknown>,
  log: JevLog,
  options: JevEvaluationOptions
): Promise<{ payload: unknown; latencyMs: number } | null> {
  if (options.signal?.aborted) return null;
  if (Array.isArray(options.allowedConnections) && options.allowedConnections.length === 0)
    return null;
  const target = resolveSystemOneTarget(config.model);
  if (!target) return null;
  const credentialProviders =
    target.provider === "opencode-zen"
      ? (["opencode-zen", "opencode-go"] as const)
      : [target.provider];
  for (const credentialProvider of credentialProviders) {
    if (options.signal?.aborted) return null;
    try {
      const credentials = await getProviderCredentialsWithQuotaPreflight(
        credentialProvider,
        null,
        options.allowedConnections ?? null,
        target.model
      );
      if (!hasUsableDecisionConnection(credentials)) continue;
      if (!isDecisionConnectionAllowed(credentials.connectionId, options.allowedConnections))
        continue;
      if (await isConnectionUnavailableToAuxiliaryActivity(credentials.connectionId)) continue;
      const token = credentials.apiKey || credentials.accessToken;
      const anonymousOpenCode = target.provider === "opencode" && credentials.authType === "none";
      if ((!token || typeof token !== "string") && !anonymousOpenCode) continue;
      const proxyInfo = await resolveProxyForConnection(
        credentials.connectionId,
        undefined,
        credentialProvider
      );
      if (
        !proxyInfo?.proxy &&
        hasBlockingProxyAssignment(credentials.connectionId, credentialProvider)
      ) {
        log.warn("JEV", `Assigned proxy unavailable via ${credentialProvider}`);
        continue;
      }
      const startedAt = Date.now();
      const result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
        forwardSystemOne(
          target,
          typeof token === "string" ? token : null,
          { state, questions },
          { timeoutMs: JEV_TIMEOUT_MS, signal: options.signal ?? undefined }
        )
      );
      if (!result.response.ok) {
        log.warn(
          "JEV",
          `Evaluation unavailable via ${credentialProvider}: ${result.response.status}`
        );
        continue;
      }
      const payload = await result.response.json().catch(() => null);
      if (result.usage) {
        try {
          await saveRequestUsage({
            provider: target.provider,
            model: target.model,
            connectionId: credentials.connectionId,
            apiKeyId: options.apiKeyId ?? null,
            endpoint: "/v1/systemone",
            tokens: result.usage,
            status: "success",
          });
        } catch {
          log.warn("JEV", "Evaluation usage could not be persisted; abstaining without retry");
          return null;
        }
      }
      return { payload, latencyMs: Date.now() - startedAt };
    } catch {
      log.warn("JEV", `Evaluation unavailable via ${credentialProvider}`);
    }
  }
  return null;
}

/**
 * Ask a stored System One connection for a bounded tier classification.
 * This is an optional routing signal: unavailable or inconclusive evaluations
 * return null, preserving the deterministic auto-combo result.
 */
export async function classifyJevRoutingTier(
  body: Record<string, unknown>,
  config: JevRoutingConfig,
  log: JevLog,
  options: JevEvaluationOptions = {}
): Promise<ComplexityTier | null> {
  if (config.mode !== "jev") return null;
  const state = buildState(body, {
    maxStateChars: JEV_STATE_CHAR_BUDGET,
    dropSystem: true,
  });
  if (!state.request && !state.conversation?.length) return null;
  const result = await askJevFromStoredConnection(
    config,
    state,
    {
      tier: {
        type: "choice",
        instructions: JEV_DEFAULT_INSTRUCTIONS,
        criteria: JEV_DEFAULT_CRITERIA,
      },
    },
    log,
    options
  );
  const tier = readJevTier(result?.payload);
  if (!tier) {
    log.info("JEV", "Evaluation inconclusive; retaining deterministic routing");
    return null;
  }
  log.info("JEV", `Evaluation tier=${tier}`);
  return jevTierToMinimum(tier);
}

/** Optional direct Auto-Combo model choice; an inconclusive verdict preserves the existing scorer. */
export async function decideJevModel(
  body: Record<string, unknown>,
  config: JevRoutingConfig,
  candidates: JevModelCandidate[],
  budgetCap: number | null | undefined,
  estimatedInputTokens: number,
  log: JevLog,
  options: JevEvaluationOptions = {}
): Promise<string | null> {
  if (config.mode !== "jev" || config.modelMode !== "jev" || isEncryptedTask(body)) return null;
  const pool = buildJevModelPool(candidates, budgetCap, estimatedInputTokens);
  if (pool.length < 2 || pool.length > 255) return null;
  const criteria = new Map(
    pool.map((candidate) => [
      candidate.id,
      resolveCriteria({ provider: candidate.provider, model: candidate.model }),
    ])
  );
  // Do not silently omit unknown models from the question or ask JEV to choose
  // using an uninformative name alone.
  if ([...criteria.values()].some((description) => !description)) return null;
  const state = buildState(body, { maxStateChars: JEV_STATE_CHAR_BUDGET, dropSystem: true });
  if (!state.request && !state.conversation?.length) return null;
  const { questions } = buildModelQuestions(
    pool.map((candidate) => candidate.id),
    (id) => criteria.get(id) ?? null
  );
  const result = await askJevFromStoredConnection(config, state, questions, log, options);
  return readJevModelChoice(result?.payload, pool);
}

/** Optional tool choice for a combo turn; every inconclusive answer leaves the body untouched. */
export async function decideJevTool(
  body: Record<string, unknown>,
  format: string,
  provider: string,
  config: JevRoutingConfig,
  log: JevLog,
  options: JevEvaluationOptions = {}
): Promise<(ToolDecisionResult & { latencyMs?: number }) | null> {
  if (config.mode !== "jev" || config.toolMode === "off") return null;
  if (UNSUPPORTED_EXECUTORS.has(provider) || hasPinnedToolChoice(body, format)) return null;
  if (isEncryptedTask(body)) return null;
  const tools = extractTools(body, format);
  if (tools.length === 0) return null;
  const kept = shortlistTools(tools, body);
  if (kept.length === 0) return null;
  const state = buildState(body, { maxStateChars: 6000 });
  if (!state.request && !state.conversation?.length) return null;
  const { questions } = buildToolQuestions(kept);
  const result = await askJevFromStoredConnection(config, state, questions, log, options);
  if (!result?.payload || typeof result.payload !== "object") return null;
  const answers = (result.payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const thinking = body.thinking;
  const extendedThinking =
    thinking !== null &&
    typeof thinking === "object" &&
    typeof (thinking as { type?: unknown }).type === "string" &&
    (thinking as { type: string }).type !== "disabled";
  const verdict = resolveToolDecision({
    answers: normalizeAnswers(answers as Record<string, unknown>),
    tools: kept.map((tool) => tool.name),
    plans: kept,
    allowed: config.toolMode,
    extendedThinking,
  });
  return { ...verdict, latencyMs: result.latencyMs };
}

/** One paid tool evaluation at most per target dispatch, even when chat retries upstream. */
export function createJevToolDecision(
  config: JevRoutingConfig,
  allowed: boolean,
  log: JevLog,
  options: JevEvaluationOptions = {}
) {
  if (!allowed || config.mode !== "jev" || config.toolMode === "off") return null;
  let attempted = false;
  return async ({
    body,
    format,
    provider,
  }: {
    body: Record<string, unknown>;
    format: string;
    provider: string;
    model: string;
  }) => {
    if (attempted) return null;
    attempted = true;
    return decideJevTool(body, format, provider, config, log, options);
  };
}
