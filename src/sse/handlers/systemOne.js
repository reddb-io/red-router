import {
  clearAccountError,
  extractApiKey,
  getProviderCredentials,
  isValidApiKey,
  markAccountUnavailable,
} from "../services/auth.js";
import { getApiKeyOwner, getSettings } from "@/lib/localDb";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getComboModels, resolveRedRouterHop } from "../services/model.js";
import {
  handleRedRouterSystemOneCore,
  handleSystemOneCore,
  getSystemOneProviderOrder,
  normalizeSystemOneModel,
  resolveSystemOneProviderModel,
  validateSystemOneRequest,
} from "open-sse/handlers/systemOneCore.js";
import { systemOneCredentialProviders } from "open-sse/config/systemOne.js";
import {
  RED_ROUTER_CHAIN_HEADER,
  RED_ROUTER_INSTANCE_ID,
  RED_ROUTER_PROVIDER_ID,
  appendRedRouterHop,
  parseRedRouterChain,
} from "open-sse/config/redRouter.js";
import { providerIdentity } from "open-sse/providers/identity.js";
import { errorResponse, responseFromRoutingCandidate } from "open-sse/utils/error.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { checkModelAccess, checkComboAccess } from "@/lib/modelAccess";
import { checkApiKeyLimits } from "@/lib/apiKeyLimits";
import { isInternalCall } from "../services/internalCall.js";

function exactSystemOneUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}
export async function handleSystemOne(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const clientApiKey = extractApiKey(request);
  const settings = await getSettings();

  if (settings.requireApiKey) {
    if (!clientApiKey) return errorResponse(401, "Missing API key");
    if (!(await isValidApiKey(clientApiKey))) return errorResponse(401, "Invalid API key");
  }

  // The router's own classifier calls come from a request that already passed
  // these checks; everything else is held to the key's limits and model rules.
  const enforceKey = !isInternalCall(request);
  if (enforceKey) {
    const overLimit = await checkApiKeyLimits(clientApiKey);
    if (overLimit) return responseFromRoutingCandidate(overLimit);
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const comboOwner = settings.scopeResourcesByUser === true
    ? await getApiKeyOwner(clientApiKey || null)
    : undefined;
  const comboModels = typeof body.model === "string"
    ? await getComboModels(body.model, comboOwner)
    : null;
  // A chained id ("red-router/opencode-zen/jev-1.13") names its model for the
  // upstream router to judge; only the request's shape is checked here.
  const leadModel = comboModels ? comboModels[0] : body.model;
  const hop = await systemOneRouterHop(leadModel);
  const validationError = validateSystemOneRequest({ ...body, model: hop ? undefined : leadModel });
  if (validationError) return errorResponse(400, validationError);
  // A request that already passed through this router came back around a cycle.
  if (parseRedRouterChain(request.headers.get(RED_ROUTER_CHAIN_HEADER)).includes(RED_ROUTER_INSTANCE_ID)) {
    return loopResponse(body.model, "RedRouter routing loop detected");
  }

  log.request("POST", `${url.pathname} | ${body.model || "jev-latest"}`);

  if (comboModels) {
    const comboAccess = enforceKey ? await checkComboAccess(clientApiKey, body.model) : { denial: null, granted: false };
    if (comboAccess.denial) return responseFromRoutingCandidate(comboAccess.denial);
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[body.model]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SYSTEM_ONE", `Combo "${body.model}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (candidateBody, candidateModel) => handleSingleSystemOne({
        body: { ...candidateBody, model: candidateModel },
        request,
        url,
        clientApiKey,
        preferredConnectionId,
        enforceKey,
        grantedByCombo: comboAccess.granted,
      }),
      log,
      comboName: body.model,
      comboStrategy,
      comboStickyLimit,
      autoSwitch: false,
    });
  }

  return handleSingleSystemOne({ body, hop, request, url, clientApiKey, preferredConnectionId, enforceKey });
}

async function handleSingleSystemOne({ body, hop, request, url, clientApiKey, preferredConnectionId, enforceKey = true, grantedByCombo = false }) {
  const routerHop = hop === undefined ? await systemOneRouterHop(body.model) : hop;
  if (routerHop) {
    return handleRouterHopSystemOne({ body, hop: routerHop, request, url, clientApiKey, preferredConnectionId, enforceKey, grantedByCombo });
  }
  const model = normalizeSystemOneModel(body.model);
  if (!model) return errorResponse(400, "Invalid JEV model");
  let lastUpstreamResponse = null;
  let lastRoutingCandidate = null;

  for (const providerId of getSystemOneProviderOrder(body.model)) {
    const providerModel = resolveSystemOneProviderModel(providerId, model);
    if (!providerModel) continue;
    if (enforceKey) {
      const denial = await checkModelAccess({ apiKey: clientApiKey, providerId, model: providerModel, requested: body.model, grantedByCombo });
      if (denial) {
        lastRoutingCandidate = denial;
        continue;
      }
    }
    // The provider's own accounts first, then accounts whose key also reaches its
    // System One route (an OpenCode Go key serves the workspace's Zen JEV models).
    for (const credentialProvider of systemOneCredentialProviders(providerId)) {
      const borrowed = credentialProvider !== providerId;
      const excluded = new Set();

      while (true) {
        const credentials = await getProviderCredentials(
          credentialProvider,
          excluded,
          providerModel,
          { apiKey: clientApiKey, preferredConnectionId },
        );

        if (credentials?.noActiveCredentials || credentials?.allRateLimited) {
          lastRoutingCandidate = credentials.candidate || lastRoutingCandidate;
          break;
        }

        log.info("AUTH", `Using ${credentialProvider} account: ${credentials.connectionName}${borrowed ? ` for ${providerId} System One` : ""}`);
        const providerData = credentials.providerSpecificData || {};
        const result = await handleSystemOneCore({
          body: { ...body, model },
          credentials,
          providerId,
          signal: request.signal,
          proxyOptions: {
            connectionProxyEnabled: providerData.connectionProxyEnabled === true,
            connectionProxyUrl: providerData.connectionProxyUrl || "",
            connectionNoProxy: providerData.connectionNoProxy || "",
            vercelRelayUrl: providerData.vercelRelayUrl || "",
          },
        });

        if (result.success) {
          await clearAccountError(credentials.connectionId, credentials, providerModel);
          const tokens = exactSystemOneUsage(result.usage);
          if (tokens) {
            saveRequestUsage({
              provider: providerId,
              model: providerModel,
              connectionId: credentials.connectionId,
              apiKey: clientApiKey,
              endpoint: url.pathname,
              tokens,
              status: "success",
            }).catch(() => {});
          }
          return result.response;
        }

        // A borrowed key the provider refuses says the workspace has no access to
        // it (Zen not enabled or not paid for), not that the account is broken:
        // say so, keep the account usable for its own provider, try the next one.
        if (borrowed && BORROWED_ACCESS_STATUSES.has(result.status)) {
          log.warn("AUTH", `${providerId} refused the ${credentialProvider} key of ${credentials.connectionName} (${result.status})`);
          lastUpstreamResponse = borrowedAccessResponse(result, { providerId, credentialProvider, connectionName: credentials.connectionName, model: providerModel });
          excluded.add(credentials.connectionId);
          continue;
        }

        const { shouldFallback } = await markAccountUnavailable(
          credentials.connectionId,
          result.status,
          result.error,
          credentialProvider,
          providerModel,
          result.resetsAtMs,
        );

        lastUpstreamResponse = result.response;
        if (!shouldFallback) break;
        excluded.add(credentials.connectionId);
      }
    }
  }

  return lastUpstreamResponse || responseFromRoutingCandidate(lastRoutingCandidate);
}

/** This router's hop of a chained System One id, or null for a model served here. */
async function systemOneRouterHop(model) {
  if (typeof model !== "string" || normalizeSystemOneModel(model)) return null;
  return resolveRedRouterHop(model);
}

/**
 * A System One id through another RedRouter: forward the rest of the id to that
 * router's /v1/systemone with the connection's key, this router appended to the hop
 * chain. Each account of the connection prefix is tried in turn.
 */
async function handleRouterHopSystemOne({ body, hop, request, url, clientApiKey, preferredConnectionId, enforceKey, grantedByCombo }) {
  if (enforceKey) {
    const denial = await checkModelAccess({ apiKey: clientApiKey, providerId: RED_ROUTER_PROVIDER_ID, model: hop.model, requested: body.model, grantedByCombo });
    if (denial) return responseFromRoutingCandidate(denial);
  }
  let chain;
  try {
    chain = appendRedRouterHop(request.headers.get(RED_ROUTER_CHAIN_HEADER));
  } catch (error) {
    return loopResponse(body.model, error.message);
  }

  let lastUpstreamResponse = null;
  let lastRoutingCandidate = null;
  const excluded = new Set();
  while (true) {
    const credentials = await getProviderCredentials(
      RED_ROUTER_PROVIDER_ID,
      excluded,
      hop.model,
      { apiKey: clientApiKey, preferredConnectionId, connectionIds: hop.connectionIds || undefined },
    );
    if (!credentials || credentials.noActiveCredentials || credentials.allRateLimited) {
      lastRoutingCandidate = credentials?.candidate || lastRoutingCandidate;
      break;
    }

    log.info("AUTH", `Using red-router account: ${credentials.connectionName} for System One ${hop.model}`);
    const providerData = credentials.providerSpecificData || {};
    const result = await handleRedRouterSystemOneCore({
      body: { ...body, model: hop.model },
      credentials,
      chain,
      signal: request.signal,
      proxyOptions: {
        connectionProxyEnabled: providerData.connectionProxyEnabled === true,
        connectionProxyUrl: providerData.connectionProxyUrl || "",
        connectionNoProxy: providerData.connectionNoProxy || "",
        vercelRelayUrl: providerData.vercelRelayUrl || "",
      },
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, hop.model);
      const tokens = exactSystemOneUsage(result.usage);
      if (tokens) {
        saveRequestUsage({
          provider: RED_ROUTER_PROVIDER_ID,
          model: hop.model,
          connectionId: credentials.connectionId,
          apiKey: clientApiKey,
          endpoint: url.pathname,
          tokens,
          status: "success",
        }).catch(() => {});
      }
      return result.response;
    }

    log.warn("SYSTEM_ONE", result.error);
    lastUpstreamResponse = result.response;
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      RED_ROUTER_PROVIDER_ID,
      hop.model,
      result.resetsAtMs,
    );
    if (!shouldFallback) break;
    excluded.add(credentials.connectionId);
  }

  return lastUpstreamResponse || responseFromRoutingCandidate(lastRoutingCandidate || {
    status: 503,
    message: `No active RedRouter connection for ${body.model}`,
    provider: RED_ROUTER_PROVIDER_ID,
    model: hop.model,
  });
}

/** A chained id this router may not forward: it would loop, or exceed the hop limit. */
function loopResponse(model, reason) {
  return errorResponse(508, `${reason}; not forwarding ${model}`, { reason: "routing_loop", retryable: false });
}

// Upstream answers meaning "this key may not use this provider": unauthorized,
// payment required, forbidden.
const BORROWED_ACCESS_STATUSES = new Set([401, 402, 403]);

/** The upstream refusal, with who refused which key and why it likely happened. */
function borrowedAccessResponse(result, { providerId, credentialProvider, connectionName, model }) {
  const provider = providerIdentity(providerId)?.name || providerId;
  const account = providerIdentity(credentialProvider)?.name || credentialProvider;
  const message = `${provider} refused ${model} with the key of your ${account} connection "${connectionName}" `
    + `(HTTP ${result.status}: ${result.error}). The account behind that key needs ${provider} access, `
    + `or add a ${provider} connection.`;
  return errorResponse(result.status, message);
}
