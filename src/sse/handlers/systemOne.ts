import { z } from "zod";

import {
  forwardSystemOne,
  resolveSystemOneTarget,
} from "@omniroute/open-sse/handlers/systemOneCore.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { hasBlockingProxyAssignment } from "@/lib/db/proxies";
import {
  extractApiKey,
  getProviderCredentialsWithQuotaPreflight,
  isValidApiKey,
  markAccountUnavailable,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { saveRequestUsage } from "@/lib/usage/usageHistory";

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

function getBearer(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== "object") return null;
  const value = credentials as { apiKey?: unknown; accessToken?: unknown };
  const token = value.apiKey || value.accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

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
  const target = resolveSystemOneTarget(parsed.data.model);
  if (!target) return errorResponse(400, "Unsupported System One model");

  const clientKey = extractApiKey(request);
  if (isRequireApiKeyEnabled() && (!clientKey || !(await isValidApiKey(clientKey)))) {
    return errorResponse(401, "Invalid API key");
  }
  const policy = await enforceApiKeyPolicy(request, parsed.data.model || target.model);
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

  // OpenCode Go workspace credentials can reach Zen. A borrowed credential is
  // used only when no Zen connection can serve the requested evaluation model.
  const credentialProviders =
    target.provider === "opencode-zen"
      ? (["opencode-zen", "opencode-go"] as const)
      : [target.provider];
  let lastResponse: Response | null = null;
  for (const credentialProvider of credentialProviders) {
    const excluded: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const credentials = await getProviderCredentialsWithQuotaPreflight(
        credentialProvider,
        null,
        allowedConnections,
        target.model,
        {
          excludeConnectionIds: excluded,
          forcedConnectionId: requestedConnectionId,
        }
      );
      const token = getBearer(credentials);
      if (!credentials?.connectionId) break;
      const anonymousOpenCode = target.provider === "opencode" && credentials.authType === "none";
      if (!token && !anonymousOpenCode) break;
      if (requestedConnectionId && requestedConnectionId !== credentials.connectionId) break;

      let proxyInfo: Awaited<ReturnType<typeof resolveProxyForConnection>>;
      try {
        proxyInfo = await resolveProxyForConnection(
          credentials.connectionId,
          policy.apiKeyInfo?.id ?? undefined,
          credentialProvider
        );
        if (
          !proxyInfo?.proxy &&
          hasBlockingProxyAssignment(credentials.connectionId, credentialProvider)
        ) {
          return errorResponse(503, "Assigned System One proxy unavailable");
        }
      } catch {
        return errorResponse(503, "System One proxy resolution failed");
      }
      let result: Awaited<ReturnType<typeof forwardSystemOne>>;
      try {
        result = await runWithProxyContext(proxyInfo?.proxy || null, () =>
          forwardSystemOne(target, token, parsed.data, { signal: request.signal })
        );
      } catch {
        return errorResponse(503, "System One transport unavailable");
      }
      if (result.response.ok) {
        if (!anonymousOpenCode) await clearRecoveredProviderState(credentials);
        if (result.usage) {
          await saveRequestUsage({
            provider: target.provider,
            model: target.model,
            connectionId: credentials.connectionId,
            apiKeyId: policy.apiKeyInfo?.id ?? null,
            apiKeyName: policy.apiKeyInfo?.name ?? null,
            endpoint: "/v1/systemone",
            tokens: result.usage,
            status: "success",
          });
        }
        return result.response;
      }
      lastResponse = result.response;
      if (anonymousOpenCode) return result.response;
      // A workspace key refused by Zen does not imply a broken OpenCode Go
      // connection. Leave its normal coding-model traffic available.
      if (
        credentialProvider === "opencode-go" &&
        (result.response.status === 401 || result.response.status === 403)
      ) {
        excluded.push(credentials.connectionId);
        continue;
      }
      if (![408, 429, 500, 502, 503, 504, 529].includes(result.response.status)) {
        return result.response;
      }
      await markAccountUnavailable(
        credentials.connectionId,
        result.response.status,
        "System One upstream unavailable",
        credentialProvider,
        target.model,
        null,
        { headers: result.response.headers }
      );
      excluded.push(credentials.connectionId);
    }
  }
  return lastResponse ?? errorResponse(503, `No System One connection for ${target.provider}`);
}
