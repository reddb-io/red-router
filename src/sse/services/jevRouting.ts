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
import { buildState } from "@omniroute/open-sse/decision/state.ts";
import type { ComplexityTier } from "@omniroute/open-sse/services/autoCombo/complexityRouter.ts";
import type { JevRoutingConfig } from "@omniroute/open-sse/services/combo/jevConfig.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { hasBlockingProxyAssignment } from "@/lib/db/proxies";
import { getProviderCredentialsWithQuotaPreflight } from "@/sse/services/auth";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { saveRequestUsage } from "@/lib/usage/usageHistory";

type JevTier = (typeof JEV_TIERS)[number];

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

/**
 * Ask a stored System One connection for a bounded tier classification.
 * This is an optional routing signal: unavailable or inconclusive evaluations
 * return null, preserving the deterministic auto-combo result.
 */
export async function classifyJevRoutingTier(
  body: Record<string, unknown>,
  config: JevRoutingConfig,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
): Promise<ComplexityTier | null> {
  if (config.mode !== "jev") return null;
  const target = resolveSystemOneTarget(config.model);
  if (!target) return null;
  const state = buildState(body, {
    maxStateChars: JEV_STATE_CHAR_BUDGET,
    dropSystem: true,
  });
  if (!state.request && !state.conversation?.length) return null;

  const credentialProviders =
    target.provider === "opencode-zen"
      ? (["opencode-zen", "opencode-go"] as const)
      : [target.provider];
  for (const credentialProvider of credentialProviders) {
    try {
      const credentials = await getProviderCredentialsWithQuotaPreflight(
        credentialProvider,
        null,
        null,
        target.model
      );
      if (!hasUsableDecisionConnection(credentials)) continue;
      if (await isConnectionUnavailableToAuxiliaryActivity(credentials.connectionId)) continue;
      const token = credentials.apiKey || credentials.accessToken;
      const anonymousOpenCode = target.provider === "opencode" && credentials.authType === "none";
      if ((!token || typeof token !== "string") && !anonymousOpenCode) continue;
      const proxyInfo = await resolveProxyForConnection(
        credentials.connectionId,
        undefined,
        credentialProvider
      );
      // A disabled assigned proxy must not silently expose the host's direct IP.
      if (
        !proxyInfo?.proxy &&
        hasBlockingProxyAssignment(credentials.connectionId, credentialProvider)
      ) {
        log.warn("JEV", `Assigned proxy unavailable via ${credentialProvider}`);
        continue;
      }
      const result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
        forwardSystemOne(
          target,
          typeof token === "string" ? token : null,
          {
            state,
            questions: {
              tier: {
                type: "choice",
                instructions: JEV_DEFAULT_INSTRUCTIONS,
                criteria: JEV_DEFAULT_CRITERIA,
              },
            },
          },
          { timeoutMs: JEV_TIMEOUT_MS }
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
      const tier = readJevTier(payload);
      if (result.usage) {
        await saveRequestUsage({
          provider: target.provider,
          model: target.model,
          connectionId: credentials.connectionId,
          endpoint: "/v1/systemone",
          tokens: result.usage,
          status: "success",
        });
      }
      if (!tier) {
        log.info("JEV", "Evaluation inconclusive; retaining deterministic routing");
        return null;
      }
      log.info("JEV", `Evaluation tier=${tier} provider=${target.provider}`);
      return jevTierToMinimum(tier);
    } catch {
      log.warn("JEV", `Evaluation unavailable via ${credentialProvider}`);
    }
  }
  return null;
}
