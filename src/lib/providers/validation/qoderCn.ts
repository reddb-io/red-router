import { resolveQoderCnModels } from "@omniroute/open-sse/services/qoderCnModels.ts";
import { QoderCnHttpError } from "@omniroute/open-sse/services/qoderCnHttpError.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Validate against the authenticated CN catalog, never the global Qoder endpoint. */
export async function validateQoderCnProvider({
  apiKey,
  providerSpecificData = {},
  fetchImpl,
  signal,
}: {
  apiKey: string;
  providerSpecificData?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ valid: boolean; error: string | null; unsupported: false; statusCode?: number }> {
  const token = apiKey?.trim();
  if (!token || token.length > 16 * 1024 || !/^(pt|dt|jt)-[\x21-\x7e]+$/.test(token)) {
    return {
      valid: false,
      error: "Qoder CN requires a CN device token, job token, or PAT",
      unsupported: false,
      statusCode: 400,
    };
  }
  const userId = providerSpecificData.userId;
  if (!token.startsWith("pt-") && (typeof userId !== "string" || !userId)) {
    return {
      valid: false,
      error: "Qoder CN account is missing its user ID; reconnect the account",
      unsupported: false,
      statusCode: 401,
    };
  }
  try {
    const catalog = await resolveQoderCnModels(
      {
        token,
        userId: typeof userId === "string" ? userId : undefined,
        machineId:
          typeof providerSpecificData.machineId === "string"
            ? providerSpecificData.machineId
            : undefined,
      },
      { fetchImpl, signal, forceRefresh: true }
    );
    if (catalog.models.length === 0) throw new Error("Qoder CN catalog is empty");
    return { valid: true, error: null, unsupported: false };
  } catch (error) {
    const statusCode = error instanceof QoderCnHttpError ? error.statusCode : 502;
    return {
      valid: false,
      error: "Qoder CN credential or model catalog could not be verified",
      unsupported: false,
      statusCode,
    };
  }
}
