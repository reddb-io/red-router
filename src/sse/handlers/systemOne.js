import {
  clearAccountError,
  extractApiKey,
  getProviderCredentials,
  isValidApiKey,
  markAccountUnavailable,
} from "../services/auth.js";
import { getApiKeyOwner, getSettings } from "@/lib/localDb";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getComboModels } from "../services/model.js";
import {
  handleSystemOneCore,
  getSystemOneProviderOrder,
  normalizeSystemOneModel,
  resolveSystemOneProviderModel,
  validateSystemOneRequest,
} from "open-sse/handlers/systemOneCore.js";
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
  const validationError = validateSystemOneRequest(
    comboModels ? { ...body, model: comboModels[0] } : body,
  );
  if (validationError) return errorResponse(400, validationError);

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

  return handleSingleSystemOne({ body, request, url, clientApiKey, preferredConnectionId, enforceKey });
}

async function handleSingleSystemOne({ body, request, url, clientApiKey, preferredConnectionId, enforceKey = true, grantedByCombo = false }) {
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
    const excluded = new Set();

    while (true) {
      const credentials = await getProviderCredentials(
        providerId,
        excluded,
        providerModel,
        { apiKey: clientApiKey, preferredConnectionId },
      );

      if (credentials?.noActiveCredentials || credentials?.allRateLimited) {
        lastRoutingCandidate = credentials.candidate || lastRoutingCandidate;
        break;
      }

      log.info("AUTH", `Using ${providerId} account: ${credentials.connectionName}`);
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

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        result.error,
        providerId,
        providerModel,
        result.resetsAtMs,
      );

      lastUpstreamResponse = result.response;
      if (!shouldFallback) break;
      excluded.add(credentials.connectionId);
    }
  }

  return lastUpstreamResponse || responseFromRoutingCandidate(lastRoutingCandidate);
}
