import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  gitlabPatSchema,
  importGitLabPersonalAccessToken,
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
 * POST /api/oauth/gitlab/pat
 * Body: { token: string, baseUrl?: string }
 *
 * Connects GitLab Duo with a Personal Access Token. The token is verified against
 * `GET {baseUrl}/api/v4/user`; `baseUrl` must be an https DNS name that resolves to a
 * public address. The response never contains the token.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
  if (authError) return authError;

  try {
    const validation = validateBody(gitlabPatSchema, await readCappedJsonBody(request));
    if (isValidationFailure(validation)) {
      return errorResponse(400, formatValidationMessage(validation.error));
    }
    const connection = await importGitLabPersonalAccessToken(validation.data);
    return NextResponse.json({ success: true, connection });
  } catch (error) {
    return importErrorResponse(error);
  }
}
