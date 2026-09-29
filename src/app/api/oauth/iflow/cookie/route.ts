import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  iflowCookieSchema,
  importIflowCookie,
  importErrorResponse,
  readCappedJsonBody,
} from "@/lib/oauth/utils/credentialImports";
import {
  isValidationFailure,
  formatValidationMessage,
  validateBody,
} from "@/shared/validation/helpers";
import { errorResponse } from "@omniroute/open-sse/utils/error";

/**
 * POST /api/oauth/iflow/cookie
 * Body: { cookie: string } — must contain the `BXAuth=` field.
 *
 * Exchanges an iFlow web session for an API key (platform.iflow.cn, fixed host) and stores
 * an iFlow connection. The response never contains the key or the cookie.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
  if (authError) return authError;

  try {
    const validation = validateBody(iflowCookieSchema, await readCappedJsonBody(request));
    if (isValidationFailure(validation)) {
      return errorResponse(400, formatValidationMessage(validation.error));
    }
    const connection = await importIflowCookie(validation.data);
    return NextResponse.json({ success: true, connection });
  } catch (error) {
    return importErrorResponse(error);
  }
}
