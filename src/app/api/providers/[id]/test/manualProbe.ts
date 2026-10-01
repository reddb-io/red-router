import { z } from "zod";

const baseUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS base URL without credentials, query or fragment.");

export const providerConnectionTestBodySchema = z
  .object({
    validationModelId: z.string().trim().max(500).optional(),
    draft: z
      .object({
        baseUrl: baseUrl.optional(),
        apiKey: z.string().max(32768).optional(),
        validationModelId: z.string().trim().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConnectionTestDraft = NonNullable<
  z.infer<typeof providerConnectionTestBodySchema>["draft"]
>;

export function applyConnectionTestDraft<
  T extends { apiKey?: string; providerSpecificData?: unknown },
>(connection: T, draft: ConnectionTestDraft) {
  const psd =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? connection.providerSpecificData
      : {};
  return {
    ...connection,
    apiKey: draft.apiKey?.trim() || connection.apiKey,
    providerSpecificData: {
      ...psd,
      ...(draft.baseUrl !== undefined ? { baseUrl: draft.baseUrl } : {}),
      ...(draft.validationModelId !== undefined
        ? { validationModelId: draft.validationModelId }
        : {}),
    },
  };
}

// Failures in a manual probe are diagnostic, never a new routing cooldown.
// Draft probes never change the health or credentials of the saved connection.
export function isReadOnlyConnectionProbe(
  manual: boolean,
  draft: ConnectionTestDraft | undefined,
  valid: boolean
) {
  return !!draft || (manual && !valid);
}

export function canRecoverManualProbe(
  connection: {
    rateLimitedUntil?: string | null;
    lastErrorType?: string | null;
    errorCode?: unknown;
  },
  valid: boolean,
  now = Date.now()
) {
  if (!valid) return false;
  if (!(Date.parse(connection.rateLimitedUntil || "") > now)) return true;
  // Recover only a known transient auth/network/test failure. Unknown and quota
  // windows retain their routing gate until the actual window expires.
  const transientTypes = new Set([
    "network_error",
    "upstream_unavailable",
    "upstream_error",
    "upstream_auth_error",
    "token_expired",
    "token_refresh_failed",
  ]);
  const quotaCode = ["429", "402"].includes(String(connection.errorCode));
  return !quotaCode && transientTypes.has(connection.lastErrorType || "");
}
