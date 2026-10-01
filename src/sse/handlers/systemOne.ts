import { z } from "zod";
import { resolveSystemOneTarget } from "@omniroute/open-sse/handlers/systemOneCore.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { resolveAttribution } from "@/lib/usage/attribution";
import { dispatchSystemOne } from "@/sse/services/systemOneDispatch";
import { resolvePriorityDecisionTargets } from "./priorityRouting";

const MAX_SYSTEM_ONE_BODY_BYTES = 512 * 1024;

/** Count bytes while reading; Content-Length can be absent or incorrect. */
export async function readSystemOneJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("empty_body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SYSTEM_ONE_BODY_BYTES) throw new Error("body_too_large");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export const systemOneBodySchema = z
  .object({
    model: z.string().min(1).optional(),
    state: z.unknown().refine((value) => value !== undefined && value !== null),
    questions: z.record(z.string(), z.unknown()),
  })
  // The upstream protocol owns question-level validation and future fields.
  // Keep the bounded JSON trust boundary without silently stripping them.
  .passthrough();

export async function handleSystemOne(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return errorResponse(415, "Expected application/json");
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SYSTEM_ONE_BODY_BYTES) {
    return errorResponse(413, "System One request exceeds 512 KiB");
  }
  let raw: unknown;
  try {
    raw = await readSystemOneJson(request);
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      return errorResponse(413, "System One request exceeds 512 KiB");
    }
    return errorResponse(400, "Invalid JSON body");
  }
  const parsed = systemOneBodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "Invalid System One request");

  const clientKey = extractApiKey(request);
  if (isRequireApiKeyEnabled() && (!clientKey || !(await isValidApiKey(clientKey)))) {
    return errorResponse(401, "Invalid API key");
  }
  const priorityTargets = parsed.data.model
    ? await resolvePriorityDecisionTargets({
        apiKey: clientKey,
        tenantId: clientKey ? ((await getApiKeyMetadata(clientKey))?.tenantId ?? null) : null,
        requestedModel: parsed.data.model,
      })
    : null;
  if (priorityTargets && !priorityTargets.length) {
    return errorResponse(400, "Unsupported System One model");
  }
  const targets = (priorityTargets ?? [parsed.data.model])
    .map(resolveSystemOneTarget)
    .filter(
      (target): target is NonNullable<ReturnType<typeof resolveSystemOneTarget>> => target !== null
    );
  if (!targets.length) return errorResponse(400, "Unsupported System One model");
  const policy = await enforceApiKeyPolicy(
    request,
    priorityTargets?.[0] || parsed.data.model || resolveSystemOneTarget()?.model
  );
  if (policy.rejection) return policy.rejection;

  const requestedConnectionId = request.headers.get("x-connection-id");
  const allowedConnections = policy.apiKeyInfo?.allowedConnections ?? null;
  if (
    requestedConnectionId &&
    allowedConnections?.length &&
    !allowedConnections.includes(requestedConnectionId)
  ) {
    return errorResponse(403, "Connection is not allowed for this API key");
  }

  let lastResponse: Response | null = null;
  const attribution = resolveAttribution(request, parsed.data, policy.apiKeyInfo);
  for (const target of targets) {
    const result = await dispatchSystemOne(target, parsed.data, {
      allowedConnections,
      forcedConnectionId: requestedConnectionId,
      apiKeyId: policy.apiKeyInfo?.id,
      apiKeyName: policy.apiKeyInfo?.name,
      attribution,
      signal: request.signal,
      warn: (message) => console.warn(message),
    });
    if (result.response.ok) return result.response;
    lastResponse = result.response;
    if (![408, 429, 500, 502, 503, 504, 529].includes(lastResponse.status)) return lastResponse;
  }
  return lastResponse ?? errorResponse(503, `No System One connection for ${targets[0].provider}`);
}
