import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { createErrorResponse } from "@/lib/api/errorResponse";
import {
  getRoutingProfile,
  getRoutingProfileBinding,
  listRoutingProfiles,
  setRoutingProfileBinding,
  setInstanceProfileOverrides,
} from "@/lib/db/routingProfiles";
import { getTenantRoutingRow, listRoutableProviders } from "@/lib/db/routingPolicy";
import { listTenants } from "@/lib/db/tenants";
import {
  getInstanceRoutingPolicy,
  normalizeProviderPriority,
  resolveRoutingPolicy,
} from "@/lib/routing/routingPolicy";
import { getProviderById } from "@/shared/constants/providers";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const updateSchema = z
  .object({
    transparent: z.boolean().nullable().optional(),
    providerPriority: z.array(z.string().trim().min(1).max(100)).max(300).nullable().optional(),
    profileId: z.string().min(1).max(100).nullable().optional(),
    delegateToTenants: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const providerLabel = (id: string): string =>
  (getProviderById(id) as { name?: string } | undefined)?.name || id;

/** GET /api/routing — the instance policy, the providers it can order, and every tenant's standing. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const instance = await getInstanceRoutingPolicy();
  const providers = listRoutableProviders(null).map((row) => ({
    id: row.provider,
    name: providerLabel(row.provider),
    connections: row.connections,
  }));
  const tenants = await Promise.all(
    listTenants().map(async (tenant) => {
      const row = getTenantRoutingRow(tenant.id);
      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        isDefault: tenant.isDefault,
        ownerPin: {
          profileId: getRoutingProfileBinding(tenant.id)?.profileId ?? null,
          transparent: row?.ownerTransparent ?? null,
          providerPriority: row?.ownerPriority ?? null,
        },
        tenantChoice: {
          transparent: row?.tenantTransparent ?? null,
          providerPriority: row?.tenantPriority ?? null,
        },
        effective: await resolveRoutingPolicy(tenant.id),
      };
    })
  );
  return NextResponse.json(
    { policy: instance, providers, tenants, profiles: listRoutingProfiles() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** PUT /api/routing — the owner sets the instance's mode, provider order and delegation. */
export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  const validation = validateBody(updateSchema, raw);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { transparent, providerPriority, delegateToTenants, profileId } = validation.data;
  const nextProfileId = profileId === undefined ? getRoutingProfileBinding()?.profileId : profileId;
  if (nextProfileId && !getRoutingProfile(nextProfileId))
    return createErrorResponse({ status: 404, message: "Routing profile not found." });
  if (!nextProfileId && (transparent === null || providerPriority === null))
    return createErrorResponse({
      status: 400,
      message: "Inherit is available only with an instance profile attached.",
    });

  if (profileId !== undefined) setRoutingProfileBinding(profileId);
  if (nextProfileId)
    setInstanceProfileOverrides({
      transparent,
      providerPriority:
        providerPriority === undefined
          ? undefined
          : providerPriority === null
            ? null
            : normalizeProviderPriority(providerPriority),
    });

  await updateSettings({
    ...(!nextProfileId && transparent !== undefined ? { transparentModels: transparent } : {}),
    ...(!nextProfileId && providerPriority !== undefined
      ? { providerPriority: normalizeProviderPriority(providerPriority) }
      : {}),
    ...(delegateToTenants !== undefined ? { delegateRoutingToTenants: delegateToTenants } : {}),
  });
  logAuditEvent({
    action: "routing.policy.updated",
    actor: await auditActorFor(request),
    target: "instance",
    resourceType: "routing_policy",
    status: "success",
    metadata: { transparent, delegateToTenants, profileId, providers: providerPriority?.length },
  });
  void getSettings;
  return NextResponse.json({ policy: await getInstanceRoutingPolicy() });
}
