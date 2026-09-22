import "open-sse/index.js";
import { createHash } from "node:crypto";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getExhaustedQuotaResetMs } from "../services/quotaReset.js";
import { getSettings, getApiKeyOwner, getApiKeyIdentity } from "@/lib/localDb";
import { resolveScopedSettings, headroomProjectUrl } from "@/lib/auth/scopedSettings";
import { getModelInfo, resolveComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { createErrorContext, errorResponse, responseFromRoutingCandidate, withRequestId } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, reorderModelsForTier } from "open-sse/services/combo.js";
import { classifyTier } from "open-sse/services/jevClassifier.js";
import {
  normalizeDecisionConfig,
  resolveDecisionTarget,
  decideComboModel,
  rankPool,
  decideTool as decideToolCore,
  readPreviousVerdict,
  rememberVerdict,
} from "../services/decisionRouter.js";
import { extractTools, hasPinnedToolChoice, supportsToolChoice, UNSUPPORTED_EXECUTORS } from "open-sse/decision/tools.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { resolveSessionId } from "open-sse/utils/sessionManager.js";
import { handleSystemOne } from "./systemOne.js";

export function effortCeilingForDeliberation(deliberation) {
  if (typeof deliberation !== "number") return null;
  if (deliberation < 0.3) return "low";
  if (deliberation < 0.7) return "medium";
  return null;
}

async function orderComboModels({ body, models, comboName, strategy, settings, apiKey, comboOwner, sessionId }) {
  const unchanged = { models, deliberation: null, decision: null };
  if (strategy !== "auto" || models.length < 2) return unchanged;
  const config = normalizeDecisionConfig(settings.decisionRouter);
  if (config.mode === "off") return unchanged;
  if (!Array.isArray(config.models) || config.models.length === 0) return unchanged;

  const target = await resolveDecisionTarget(config, { apiKey, log });
  if (!target) return unchanged;
  const ranked = await rankPool(models, async (name) => {
    const nested = await resolveComboModels(name, comboOwner);
    return nested?.models || [];
  });
  const eligible = config.models.includes(comboName)
    ? ranked
    : ranked.filter((model) => config.models.includes(model));
  if (eligible.length < 2) return unchanged;
  const scope = createHash("sha256")
    .update(`${apiKey || "local"}:${comboOwner || "shared"}:${comboName}:${sessionId || "ephemeral"}`)
    .digest("hex")
    .slice(0, 24);

  try {
    const result = await decideComboModel({
      body,
      models: eligible,
      ranked: eligible,
      comboName,
      config,
      target,
      log,
      previousVerdict: readPreviousVerdict(scope),
    });
    rememberVerdict(scope, result.decision);
    if (config.mode === "shadow") {
      log.info("DECISION", `shadow: "${comboName}" would use ${result.decision?.model || "(unchanged)"}`);
      return { ...unchanged, decision: result.decision || null };
    }
    return {
      models: [...result.models, ...ranked.filter((model) => !result.models.includes(model))],
      deliberation: result.decision?.deliberation ?? null,
      decision: result.decision || null,
    };
  } catch (error) {
    log.warn("DECISION", `model decision failed, pool order unchanged: ${error.message}`);
    return unchanged;
  }
}

function createToolDecider({ settings, apiKey }) {
  const config = normalizeDecisionConfig(settings.decisionRouter);
  if (config.mode === "off" || config.toolMode === "off") return null;

  let credentialPromise = null;
  const memo = new Map();
  return async ({ body, format, provider, model }) => {
    if (UNSUPPORTED_EXECUTORS.has(provider) || !supportsToolChoice(format)) {
      return { mode: "passthrough", reason: "executor_unsupported" };
    }
    if (hasPinnedToolChoice(body, format)) {
      return { mode: "passthrough", reason: "client_tool_choice" };
    }
    const tools = extractTools(body, format);
    if (tools.length === 0) return { mode: "passthrough", reason: "no_tools" };

    const signature = createHash("sha256")
      .update(JSON.stringify({ messages: body.messages, input: body.input, contents: body.contents, tools }))
      .digest("hex");
    const memoKey = `${provider}/${model}|${signature}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    credentialPromise ||= resolveDecisionTarget(config, { apiKey, log });
    const target = await credentialPromise;
    if (!target) return { mode: "passthrough", reason: "no_credential" };

    let result = null;
    try {
      result = await decideToolCore({ body, tools, plans: tools, config, target, log });
    } catch (error) {
      log.warn("DECISION", `tool decision failed: ${error.message}`);
    }
    const decision = config.mode === "shadow" && result && result.mode !== "passthrough"
      ? { mode: "passthrough", reason: "shadow", wouldBe: `${result.mode}:${result.tool || "-"}`, confidence: result.confidence }
      : result || { mode: "passthrough", reason: "no_answer" };
    memo.set(memoKey, decision);
    return decision;
  };
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
// undefined (not null) keeps the legacy lookup: name alone, ignoring ownership.
async function resolveComboOwner(apiKey) {
  const settings = await getSettings();
  if (settings?.scopeResourcesByUser !== true) return undefined;
  return await getApiKeyOwner(apiKey || null);
}

export async function handleChat(request, clientRawRequest = null, options = {}) {
  const errorContext = createErrorContext(request, options);
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body", errorContext);
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await resolveScopedSettings(await getSettings(), apiKey);
  const comboOwner = await resolveComboOwner(apiKey);
  const sessionId = resolveSessionId({
    headers: clientRawRequest?.headers,
    body,
    scope: "decision",
  });
  const routingContext = {
    settings,
    comboOwner,
    sessionId,
    decision: null,
    deliberation: null,
    toolDecider: createToolDecider({ settings, apiKey }),
  };
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key", errorContext);
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key", errorContext);
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model", errorContext);
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback). The name may
  // carry a thinking override suffix ("my-combo(high)") — resolution strips it
  // and re-attaches it to every member; cleanComboName keys strategies/settings.
  // Combo names are unique per owner, so resolution is scoped to the key's owner.
  const comboResolution = await resolveComboModels(modelStr, comboOwner);
  if (comboResolution) {
    const { models: comboModels, comboName: cleanComboName } = comboResolution;
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[cleanComboName]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${cleanComboName}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, errorContext, routingContext);
        },
        log,
        comboName: cleanComboName,
        judgeModel: comboStrategies[cleanComboName]?.judgeModel,
        tuning: comboStrategies[cleanComboName]?.fusionTuning,
        errorContext,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    // Smart routing: classify task complexity with Jev (TypeSafe) and reorder the
    // combo so the tier-appropriate model leads. Fail-open — on any classifier
    // miss we keep `augmentedModels` as-is and fall through to normal fallback.
    // The availability/quota ladder + capability auto-switch below are untouched.
    let effectiveStrategy = comboStrategy;
    if (comboStrategy === "smart") {
      const smartCfg = comboStrategies[cleanComboName] || {};
      const tierMap = smartCfg.smartTiers;
      const classified = await classifyTier({
        body,
        log,
        criteria: smartCfg.smartCriteria,
        instructions: smartCfg.smartInstructions,
        minConfidence: smartCfg.smartMinConfidence,
        timeoutMs: smartCfg.smartTimeoutMs,
        // Route through RedRouter's native System One cascade (TypeSafe,
        // OpenRouter, and any future compatible provider) instead of binding
        // smart routing to a process-level TypeSafe environment key.
        requestImpl: (payload, { signal }) => {
          const headers = { "Content-Type": "application/json" };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          return handleSystemOne(new Request("http://red-router.internal/v1/systemone", {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
          }));
        },
      });
      if (classified && tierMap) {
        const reordered = reorderModelsForTier(augmentedModels, classified.tier, tierMap);
        if (reordered[0] !== augmentedModels[0]) {
          log.info("CHAT", `Combo "${cleanComboName}" smart-routing tier=${classified.tier} → ${reordered[0]}`);
        }
        augmentedModels.length = 0;
        augmentedModels.push(...reordered);
      } else {
        log.info("CHAT", `Combo "${cleanComboName}" smart-routing: no confident tier — using default order`);
      }
      // Run the reordered chain through the normal fallback ladder.
      effectiveStrategy = "fallback";
    }

    let orderedModels = augmentedModels;
    if (comboStrategy === "auto") {
      const ordered = await orderComboModels({
        body,
        models: augmentedModels,
        comboName: cleanComboName,
        strategy: comboStrategy,
        settings,
        apiKey,
        comboOwner,
        sessionId: routingContext.sessionId,
      });
      orderedModels = ordered.models;
      routingContext.decision = ordered.decision;
      routingContext.deliberation = ordered.deliberation;
      effectiveStrategy = "fallback";
    }

    log.info("CHAT", `Combo "${cleanComboName}" with ${orderedModels.length} models (strategy: ${comboStrategy}${effectiveStrategy !== comboStrategy ? `→${effectiveStrategy}` : ""}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: orderedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, routingContext),
        adapterAdded
      ),
      log,
      comboName: cleanComboName,
      comboStrategy: effectiveStrategy,
      comboStickyLimit,
      errorContext,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, routingContext),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      errorContext,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, errorContext, routingContext);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, errorContext = {}, routingContext = null) {
  routingContext ||= {
    settings: await getSettings(),
    comboOwner: await resolveComboOwner(apiKey),
    sessionId: resolveSessionId({
      headers: clientRawRequest?.headers,
      body,
      scope: "decision",
    }),
    decision: null,
    deliberation: null,
  };
  if (routingContext.toolDecider === undefined) {
    routingContext.toolDecider = createToolDecider({ settings: routingContext.settings, apiKey });
  }
  // Combo names are unique per owner, so resolution needs to know whose key this is.
  const comboOwner = await resolveComboOwner(apiKey);
  const modelInfo = await getModelInfo(modelStr, comboOwner);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboResolution = await resolveComboModels(modelStr, comboOwner);
    if (comboResolution) {
      const { models: comboModels, comboName: cleanComboName } = comboResolution;
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[cleanComboName]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${cleanComboName}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, errorContext, routingContext);
          },
          log,
          comboName: cleanComboName,
          judgeModel: comboStrategies[cleanComboName]?.judgeModel,
          tuning: comboStrategies[cleanComboName]?.fusionTuning,
          errorContext,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      let orderedModels = augmentedModels;
      let effectiveStrategy = comboStrategy;
      if (comboStrategy === "auto") {
        const ordered = await orderComboModels({
          body,
          models: augmentedModels,
          comboName: cleanComboName,
          strategy: comboStrategy,
          settings: chatSettings,
          apiKey,
          comboOwner,
          sessionId: routingContext.sessionId,
        });
        orderedModels = ordered.models;
        routingContext.decision = ordered.decision;
        routingContext.deliberation = ordered.deliberation;
        effectiveStrategy = "fallback";
      }
      log.info("CHAT", `Combo "${cleanComboName}" with ${orderedModels.length} models (strategy: ${comboStrategy}${effectiveStrategy !== comboStrategy ? `→${effectiveStrategy}` : ""}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: orderedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, errorContext, routingContext),
          adapterAdded
        ),
        log,
        comboName: cleanComboName,
        comboStrategy: effectiveStrategy,
        comboStickyLimit,
        errorContext,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format", errorContext);
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { apiKey });

    if (credentials?.noActiveCredentials) {
      log.warn("AUTH", credentials.candidate.message);
      return responseFromRoutingCandidate(credentials.candidate, errorContext);
    }
    if (credentials?.allRateLimited) {
      log.warn("CHAT", `[${provider}/${model}] ${credentials.candidate.message} (${credentials.retryAfterHuman})`);
      return responseFromRoutingCandidate(credentials.candidate, errorContext);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const maxThinkingLevel = chatSettings.decisionRouter?.effort
      ? effortCeilingForDeliberation(routingContext.deliberation)
      : null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomPerApiKeyProject
        ? headroomProjectUrl(chatSettings.headroomUrl || DEFAULT_HEADROOM_URL, (await getApiKeyIdentity(apiKey)).name)
        : (chatSettings.headroomUrl || DEFAULT_HEADROOM_URL),
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      maxThinkingLevel,
      decideTool: routingContext.toolDecider,
      decision: routingContext.decision,
      errorContext,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return withRequestId(result.response, errorContext);

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData,
        result.error
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Providers whose limit error carries no reset (Kiro 402): ask their usage API.
    if (!resetsAtMs) {
      resetsAtMs = await getExhaustedQuotaResetMs(provider, result.status, refreshedCredentials);
      if (resetsAtMs) log.warn("QUOTA", `[${provider}] quota exhausted — locking until ${new Date(resetsAtMs).toISOString()}`);
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      continue;
    }

    return withRequestId(result.response, errorContext);
  }
}
