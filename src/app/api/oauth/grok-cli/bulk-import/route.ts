import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  grokBulkImportSchema,
  importGrokCliItems,
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
 * POST /api/oauth/grok-cli/bulk-import
 * Body: { items: Array<string | object> } (at most 100 items, 1 MB body).
 *
 * Each item is a Grok CLI JWT, a token-endpoint style object (snake_case or camelCase), or a
 * whole `~/.grok/auth.json`. Items are imported independently; the response lists one
 * result per item and never contains a token.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
  if (authError) return authError;

  try {
    const validation = validateBody(grokBulkImportSchema, await readCappedJsonBody(request));
    if (isValidationFailure(validation)) {
      return errorResponse(400, formatValidationMessage(validation.error));
    }
    const { items, accounts } = validation.data;
    return NextResponse.json(await importGrokCliItems((items ?? accounts) as unknown[]));
  } catch (error) {
    return importErrorResponse(error);
  }
}
