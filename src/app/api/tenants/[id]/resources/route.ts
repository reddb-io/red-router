import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { assignApiKeysToTenant, assignResourcesToTenant, getTenant } from "@/lib/db/tenants";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, assignResourcesSchema, tenantFailure } from "../../_lib";

type Context = { params: Promise<{ id: string }> };

/** POST /api/tenants/:id/resources — move API keys, connections and combos to this tenant. */
export async function POST(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await context.params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }
  const validation = validateBody(assignResourcesSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const tenant = getTenant(id);
    const tenantId = tenant?.id ?? id;
    // Keys first: it rejects instance-wide scopes before anything else moves.
    const apiKeys = validation.data.apiKeyIds?.length
      ? assignApiKeysToTenant(tenantId, validation.data.apiKeyIds)
      : 0;
    const moved = assignResourcesToTenant(tenantId, validation.data);
    logAuditEvent({
      action: "tenant.resources.assigned",
      actor: "admin",
      target: tenantId,
      resourceType: "tenant",
      status: "success",
      metadata: { apiKeys, ...moved },
    });
    return NextResponse.json({ moved: { apiKeys, ...moved } });
  } catch (error) {
    return tenantFailure(error, "Failed to assign resources");
  }
}
