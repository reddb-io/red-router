import {
  clearAccountError,
  extractApiKey,
  getProviderCredentials,
  isValidApiKey,
  markAccountUnavailable,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { saveRequestUsage } from "@/lib/usageDb.js";
import {
  handleSystemOneCore,
  getSystemOneProviderOrder,
  normalizeSystemOneModel,
  resolveSystemOneProviderModel,
  validateSystemOneRequest,
} from "open-sse/handlers/systemOneCore.js";
import { errorResponse, responseFromRoutingCandidate } from "open-sse/utils/error.js";
import * as log from "../utils/logger.js";

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

  const validationError = validateSystemOneRequest(body);
  if (validationError) return errorResponse(400, validationError);

  const url = new URL(request.url);
  const model = normalizeSystemOneModel(body.model);
  const clientApiKey = extractApiKey(request);
  const settings = await getSettings();

  log.request("POST", `${url.pathname} | ${model}`);

  if (settings.requireApiKey) {
    if (!clientApiKey) return errorResponse(401, "Missing API key");
    if (!(await isValidApiKey(clientApiKey))) return errorResponse(401, "Invalid API key");
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  let lastUpstreamResponse = null;
  let lastRoutingCandidate = null;

  for (const providerId of getSystemOneProviderOrder(body.model)) {
    const providerModel = resolveSystemOneProviderModel(providerId, model);
    if (!providerModel) continue;
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
