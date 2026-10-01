import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyMetadata, isModelAllowedForKey } from "@/lib/db/apiKeys";
import { getProviderConnectionById } from "@/lib/db/providers";
import { validateSetupSelection } from "@/lib/setup/validateSelection";
import { isValidApiKey } from "@/sse/services/auth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { errorResponse } from "@omniroute/open-sse/utils/error";
import { GET as getConnectionModels } from "../../providers/[id]/models/route";

const schema = z.object({
  connectionId: z.string().min(1).max(200),
  model: z.string().min(1).max(2048),
  apiKeyId: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(4096),
});

/** No completion, credential probe or quota reservation is performed by readiness. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  const validation = validateBody(schema, body);
  if (isValidationFailure(validation))
    return errorResponse(400, "Select a connection, model and client key");
  try {
    const selection = {
      connectionId: validation.data.connectionId!,
      model: validation.data.model!,
      apiKeyId: validation.data.apiKeyId!,
      apiKey: validation.data.apiKey!,
    };
    const readiness = await validateSetupSelection(selection, {
      connection: async (id) => {
        const connection = await getProviderConnectionById(id);
        return connection
          ? {
              isActive: connection.isActive,
              displayName: connection.displayName,
              name: connection.name,
              provider: connection.provider,
            }
          : null;
      },
      metadata: getApiKeyMetadata,
      validKey: isValidApiKey,
      modelAllowed: isModelAllowedForKey,
      models: async (connectionId) => {
        const url = new URL(
          `/api/providers/${encodeURIComponent(connectionId)}/models`,
          request.url
        );
        url.searchParams.set("capabilities", "chat");
        url.searchParams.set("excludeHidden", "true");
        const response = await getConnectionModels(
          new Request(url, {
            headers: request.headers,
            signal: request.signal,
          }),
          { params: { id: connectionId } }
        );
        if (!response.ok) return [];
        const catalog = await response.json();
        return Array.isArray(catalog.models) ? catalog.models : [];
      },
    });
    return NextResponse.json(readiness);
  } catch {
    // Neither the supplied client secret nor upstream diagnostics belong in logs/responses.
    return errorResponse(500, "Setup validation is unavailable");
  }
}
