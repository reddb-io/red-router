import { randomUUID } from "node:crypto";
import {
  forwardSystemOne,
  type SystemOneRequest,
  type SystemOneTarget,
} from "@omniroute/open-sse/handlers/systemOneCore.ts";
import { redRouterEndpoint } from "@omniroute/open-sse/config/redRouter";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import {
  checkTokenLimits,
  recordTokenUsage,
} from "@omniroute/open-sse/services/tokenLimitCounter.ts";
import { computeBillableTokens } from "@omniroute/open-sse/handlers/chatCore/upstreamTimeouts.ts";
import { checkKeyQuota, recordKeyQuotaUsage } from "@/domain/keyQuota";
import { normalizeUsage } from "@omniroute/open-sse/utils/usageTracking.ts";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { hasBlockingProxyAssignment } from "@/lib/db/proxies";
import { readRemoteRouterCatalog } from "@/lib/db/remoteRouterCatalog";
import {
  remoteRouterSnapshot,
  isRemoteDecisionModel,
} from "@/lib/providerModels/remoteRouterCatalog";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { saveRequestUsage } from "@/lib/usage/usageHistory";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";
import { rejectIfMeteredBudgetExceeded, meteredBudgetCost } from "@/lib/usage/meteredBudgetPolicy";
import { recordCost } from "@/domain/costRules";
import { beginFinancialRequest, finishFinancialRequest } from "@/lib/usage/financialAdmission";
import { recordBudgetTokensFor } from "@/domain/budgetEngine";
import type { RequestAttribution } from "@/lib/usage/attribution";
import {
  getProviderCredentialsWithQuotaPreflight,
  markAccountUnavailable,
  clearRecoveredProviderState,
} from "./auth";

const defaults = {
  credentials: getProviderCredentialsWithQuotaPreflight,
  proxy: resolveProxyForConnection,
  blockedProxy: hasBlockingProxyAssignment,
  leased: isConnectionUnavailableToAuxiliaryActivity,
  catalog: readRemoteRouterCatalog,
  forward: forwardSystemOne,
  budget: rejectIfMeteredBudgetExceeded,
  usage: saveRequestUsage,
  cost: calculateCostDetailed,
  recordCost,
  recordTokens: recordBudgetTokensFor,
  keyQuota: checkKeyQuota,
  tokenLimits: checkTokenLimits,
  recordKeyQuota: recordKeyQuotaUsage,
  recordWindowTokens: recordTokenUsage,
  recover: clearRecoveredProviderState,
  unavailable: markAccountUnavailable,
};

export type SystemOneDispatchOptions = {
  allowedConnections?: string[] | null;
  forcedConnectionId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  attribution?: RequestAttribution | null;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

/** Shared by public decisions and internal JEV: one authorization, transport and accounting path. */
export async function dispatchSystemOne(
  target: SystemOneTarget,
  body: SystemOneRequest,
  options: SystemOneDispatchOptions = {},
  overrides: Partial<typeof defaults> = {}
): Promise<{ response: Response; accountingSucceeded: boolean }> {
  const deps = { ...defaults, ...overrides };
  if (options.timeoutMs !== undefined) {
    const deadline = AbortSignal.timeout(Math.max(100, Math.min(options.timeoutMs, 30000)));
    options = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    };
  }
  const fail = (status: number, message: string) => ({
    response: errorResponse(status, message),
    accountingSucceeded: false,
  });
  if (options.signal?.aborted) return fail(499, "System One request cancelled");
  if (Array.isArray(options.allowedConnections) && options.allowedConnections.length === 0) {
    return fail(403, "No System One connection is allowed");
  }
  if (
    options.forcedConnectionId &&
    options.allowedConnections &&
    !options.allowedConnections.includes(options.forcedConnectionId)
  ) {
    return fail(403, "Connection is not allowed for this API key");
  }
  if (options.apiKeyId) {
    try {
      const quota = deps.keyQuota(options.apiKeyId);
      if (!quota.allowed) return fail(429, quota.reason || "API key quota exceeded");
      if (deps.tokenLimits(options.apiKeyId, target.provider, target.model)) {
        return fail(429, "Token limit exceeded for this API key");
      }
    } catch {
      return fail(503, "System One quota policy unavailable");
    }
  }
  const actor = { id: options.apiKeyId, attribution: options.attribution };
  // Admission is once per evaluation, not once per credential retry.
  const admission = overrides.budget
    ? { id: null, error: await deps.budget(actor, target.provider, target.model) }
    : await beginFinancialRequest(
        actor,
        target.provider,
        target.model,
        body as unknown as Record<string, unknown>
      );
  if (admission.error) return { response: admission.error, accountingSucceeded: false };
  try {
    const providers =
      target.provider === "opencode-zen" ? ["opencode-zen", "opencode-go"] : [target.provider];
    let last: Response | null = null;
    for (const provider of providers) {
      const excluded: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (options.signal?.aborted) return fail(499, "System One request cancelled");
        const credentials = await deps.credentials(
          provider,
          null,
          options.allowedConnections ?? null,
          target.model,
          {
            excludeConnectionIds: excluded,
            forcedConnectionId: options.forcedConnectionId,
            modelModality: "systemone",
          }
        );
        if (
          !credentials ||
          !("connectionId" in credentials) ||
          typeof credentials.connectionId !== "string"
        )
          break;
        const id = credentials.connectionId;
        if (options.forcedConnectionId && id !== options.forcedConnectionId) break;
        if (options.allowedConnections && !options.allowedConnections.includes(id)) break;
        const value = credentials as { apiKey?: string; accessToken?: string; authType?: string };
        const token = value.apiKey || value.accessToken || null;
        const anonymous = target.provider === "opencode" && value.authType === "none";
        if (!token && !anonymous) break;
        if (await deps.leased(id)) {
          if (options.forcedConnectionId) return fail(409, "System One connection is leased");
          excluded.push(id);
          continue;
        }
        let proxyInfo: Awaited<ReturnType<typeof resolveProxyForConnection>>;
        try {
          proxyInfo = await deps.proxy(id, options.apiKeyId ?? undefined, provider);
          if (!proxyInfo?.proxy && deps.blockedProxy(id, provider)) {
            return fail(503, "Assigned System One proxy unavailable");
          }
        } catch {
          return fail(503, "System One proxy resolution failed");
        }
        let effectiveTarget = target;
        if (target.provider === "red-router") {
          try {
            const snapshot = remoteRouterSnapshot({ ...credentials, provider: "red-router", id });
            const catalog = deps.catalog(snapshot);
            if (
              !catalog?.models.some(
                (model) => model.id === target.model && isRemoteDecisionModel(model)
              )
            ) {
              excluded.push(id);
              continue;
            }
            effectiveTarget = { ...target, url: redRouterEndpoint(snapshot.url, "systemone") };
          } catch {
            excluded.push(id);
            continue;
          }
        }
        const started = Date.now();
        let result: Awaited<ReturnType<typeof forwardSystemOne>>;
        try {
          result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
            deps.forward(effectiveTarget, token, body, {
              signal: options.signal ?? undefined,
              timeoutMs: options.timeoutMs,
              ...(target.provider === "red-router"
                ? {
                    fetchImpl: (url, init) =>
                      safeOutboundFetch(String(url), {
                        ...init,
                        guard: getProviderOutboundGuard(),
                        allowRedirect: false,
                        retry: false,
                        timeoutMs: options.timeoutMs ?? 15000,
                        proxyConfig: proxyInfo?.proxy || null,
                      }),
                  }
                : {}),
            })
          );
        } catch {
          return fail(503, "System One transport unavailable");
        }
        if (result.response.ok) {
          // A paid, completed evaluation is never retried because a local side effect failed.
          let accountingSucceeded = true;
          try {
            if (!anonymous) await deps.recover(credentials);
          } catch {
            options.warn?.("System One connection recovery state could not be cleared");
          }
          const tokens = normalizeUsage(result.usage);
          if (tokens) {
            try {
              const cost = await deps.cost(target.provider, target.model, tokens);
              if (!cost.priced)
                options.warn?.("System One usage has no catalog price; cost remains unpriced");
              if (options.apiKeyId) {
                deps.recordCost(
                  options.apiKeyId,
                  meteredBudgetCost(target.provider, cost.costUsd),
                  {
                    provider: target.provider,
                    model: target.model,
                    tokens,
                    requestId: randomUUID(),
                    attribution: options.attribution,
                  }
                );
              }
            } catch {
              accountingSucceeded = false;
              options.warn?.("System One cost accounting failed");
            }
            try {
              if (options.apiKeyId) {
                const billable = computeBillableTokens(tokens);
                deps.recordTokens(actor, target.provider, billable);
                deps.recordKeyQuota(options.apiKeyId, billable);
                deps.recordWindowTokens(options.apiKeyId, target.provider, target.model, billable);
              }
            } catch {
              accountingSucceeded = false;
            }
            try {
              if (
                (await deps.usage({
                  provider: target.provider,
                  model: target.model,
                  connectionId: id,
                  apiKeyId: options.apiKeyId ?? null,
                  apiKeyName: options.apiKeyName ?? null,
                  endpoint: "/v1/systemone",
                  tokens,
                  status: "success",
                  latencyMs: Date.now() - started,
                })) === false
              ) {
                accountingSucceeded = false;
              }
            } catch {
              accountingSucceeded = false;
            }
          }
          if (!tokens && options.apiKeyId) {
            try {
              deps.recordKeyQuota(options.apiKeyId, 0);
            } catch {
              accountingSucceeded = false;
            }
          }
          return { response: result.response, accountingSucceeded };
        }
        last = result.response;
        if (anonymous) return { response: last, accountingSucceeded: false };
        // Zen rejecting a borrowed Go key must not disable ordinary Go coding traffic.
        if (provider === "opencode-go" && [401, 403].includes(last.status)) {
          excluded.push(id);
          continue;
        }
        if (![408, 429, 500, 502, 503, 504, 529].includes(last.status)) {
          return { response: last, accountingSucceeded: false };
        }
        await deps.unavailable(
          id,
          last.status,
          "System One upstream unavailable",
          provider,
          target.model,
          null,
          { headers: last.headers }
        );
        excluded.push(id);
      }
    }
    return {
      response: last ?? errorResponse(503, `No System One connection for ${target.provider}`),
      accountingSucceeded: false,
    };
  } finally {
    finishFinancialRequest(admission.id);
  }
}
