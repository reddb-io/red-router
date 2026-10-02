import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { getTenantRoutingRow, setTenantRoutingSide } from "@/lib/db/routingPolicy";
import { getTenant } from "@/lib/db/tenants";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  getRoutingProfile,
  getRoutingProfileBinding,
  setRoutingProfileBinding,
} from "@/lib/db/routingProfiles";
import { normalizeProviderPriority, resolveRoutingPolicy } from "@/lib/routing/routingPolicy";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type Context = { params: Promise<{ id: string }> };

// null clears what the owner pinned, so the tenant (if delegated) or the instance decides again.
const pinSchema = z
  .object({
    transparent: z.boolean().nullable().optional(),
    priority: z.array(z.string().trim().min(1).max(100)).max(300).nullable().optional(),
    profileId: z.string().min(1).max(100).nullable().optional(),
  })
  .refine(
    (value) =>
      value.transparent !== undefined ||
      value.priority !== undefined ||
      value.profileId !== undefined,
    {
      message: "Nothing to update",
    }
  );

/** GET /api/tenants/:id/routing — what is pinned for the tenant, what it chose, and what applies. */
export async function GET(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const tenant = getTenant((await context.params).id);
  if (!tenant)
    return NextResponse.json({ error: { message: "Tenant not found." } }, { status: 404 });
  const row = getTenantRoutingRow(tenant.id);
  return NextResponse.json({
    ownerPin: {
      transparent: row?.ownerTransparent ?? null,
      priority: row?.ownerPriority ?? null,
      profileId: getRoutingProfileBinding(tenant.id)?.profileId ?? null,
    },
    tenantChoice: {
      transparent: row?.tenantTransparent ?? null,
      priority: row?.tenantPriority ?? null,
    },
    effective: await resolveRoutingPolicy(tenant.id),
  });
}

/** PUT /api/tenants/:id/routing — the owner pins (or clears) the tenant's mode and provider order. */
export async function PUT(request: Request, context: Context) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const tenant = getTenant((await context.params).id);
  if (!tenant)
    return NextResponse.json({ error: { message: "Tenant not found." } }, { status: 404 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const validation = validateBody(pinSchema, raw);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { transparent, priority, profileId } = validation.data;
  if (profileId && !getRoutingProfile(profileId))
    return createErrorResponse({ status: 404, message: "Routing profile not found." });
  if (profileId !== undefined) setRoutingProfileBinding(profileId, tenant.id);

  setTenantRoutingSide(tenant.id, "owner", {
    transparent,
    priority:
      priority === undefined
        ? undefined
        : priority === null
          ? null
          : normalizeProviderPriority(priority),
  });
  logAuditEvent({
    action: "routing.tenant.pinned",
    actor: await auditActorFor(request),
    target: tenant.id,
    resourceType: "tenant",
    status: "success",
    metadata: { transparent: transparent ?? undefined, profileId, providers: priority?.length },
  });
  return NextResponse.json({ effective: await resolveRoutingPolicy(tenant.id) });
}
