/**
 * Who performed a management action, for the audit trail.
 *
 * The dashboard session carries its identity (`owner`, `oidc:<e-mail>`, `saml:<e-mail>`), so an action
 * is attributed to a person rather than a generic "admin". Other credentials are named by kind:
 * `api-key:<id>` for a management key and `cli` for the local CLI token. Sessions minted before the
 * identity claim existed belong to the owner: it was the only identity there was. Callers that have
 * no authenticated caller (a failed sign-in) keep passing "anonymous" themselves.
 */

import { getDashboardSessionPayload } from "@/shared/utils/apiAuth";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";

export const LEGACY_SESSION_ACTOR = "owner";
export const UNKNOWN_ACTOR = "admin";

export async function auditActorFor(request?: Request | null): Promise<string> {
  if (!request) return UNKNOWN_ACTOR;
  try {
    const session = await getDashboardSessionPayload(request);
    if (session) {
      return typeof session.sub === "string" && session.sub ? session.sub : LEGACY_SESSION_ACTOR;
    }
    const { extractApiKey } = await import("@/sse/services/auth");
    const apiKey = extractApiKey(request, { allowUrl: false });
    if (apiKey) {
      const { getApiKeyMetadata } = await import("@/lib/db/apiKeys");
      const meta = await getApiKeyMetadata(apiKey);
      if (meta?.id) return `api-key:${meta.id}`;
    }
    if (await isCliTokenAuthValid(request)) return "cli";
  } catch {
    // Attribution must never break the action it describes.
  }
  return UNKNOWN_ACTOR;
}
