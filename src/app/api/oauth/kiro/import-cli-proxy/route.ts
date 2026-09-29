import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/db/providers";
import { findKiroConnectionByIdentity } from "@/lib/oauth/kiroConnectionIdentity";
import {
  KiroExternalIdpImportError,
  normalizeKiroExternalIdpAuth,
} from "@/lib/oauth/kiroExternalIdp";
import { importErrorResponse, readCappedJsonBody } from "@/lib/oauth/utils/credentialImports";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { errorResponse } from "@omniroute/open-sse/utils/error";

// The auth file itself, or a wrapper naming it `cliProxyAuth` / `auth` / `json` (9router's
// accepted shapes). Each may be an object or the pasted JSON text.
const authValue = z.union([
  z.record(z.string(), z.unknown()),
  z
    .string()
    .min(1)
    .max(64 * 1024),
]);
const bodySchema = z
  .object({
    cliProxyAuth: authValue.optional(),
    auth: authValue.optional(),
    json: authValue.optional(),
  })
  .passthrough();

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Body: a CLIProxyAPI `type: "kiro"` auth file (`auth_method: "external_idp"`), either as the
 * body itself or wrapped in `{ cliProxyAuth }` / `{ auth }` / `{ json }`.
 *
 * Requires management authorization (`/api/oauth/` is a public prefix, so the check is done
 * here). Responses carry only the connection id/provider/email and fixed error messages;
 * tokens are never echoed.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
  if (authError) return authError;

  try {
    const validation = validateBody(bodySchema, await readCappedJsonBody(request));
    if (isValidationFailure(validation)) return errorResponse(400, "Invalid request body");
    const body = validation.data;
    const rawAuth = body.cliProxyAuth ?? body.auth ?? body.json ?? body;

    let tokenData: ReturnType<typeof normalizeKiroExternalIdpAuth>;
    try {
      tokenData = normalizeKiroExternalIdpAuth(rawAuth);
    } catch (error) {
      if (error instanceof KiroExternalIdpImportError) return errorResponse(400, error.message);
      throw error;
    }

    const record = {
      accessToken: tokenData.accessToken || null,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      tokenExpiresAt: tokenData.expiresAt,
      email: tokenData.email,
      providerSpecificData: { ...tokenData.providerSpecificData, importedFrom: "cliproxyapi" },
      testStatus: "active",
      isActive: true,
    };
    // Re-importing the same account updates it in place instead of adding a duplicate.
    const existing = await getProviderConnections({ provider: "kiro" });
    const match = findKiroConnectionByIdentity(existing, {
      authType: "oauth",
      profileArn: tokenData.providerSpecificData.profileArn,
      clientId: tokenData.providerSpecificData.clientId,
      email: tokenData.email,
    });
    const connection = (
      typeof match?.id === "string"
        ? await updateProviderConnection(match.id, record)
        : await createProviderConnection({
            provider: "kiro",
            authType: "oauth",
            ...record,
          })
    ) as { id?: unknown; email?: unknown } | null;

    return NextResponse.json({
      success: true,
      connection: {
        id: connection?.id,
        provider: "kiro",
        email: connection?.email ?? tokenData.email,
      },
    });
  } catch (error) {
    return importErrorResponse(error);
  }
}
