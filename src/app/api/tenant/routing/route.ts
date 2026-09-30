import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantAuth } from "@/lib/api/requireTenantAuth";
import { logAuditEvent } from "@/lib/compliance/index";
import { auditActorFor } from "@/lib/compliance/auditActor";
import {
  getTenantRoutingRow,
  listRoutableProviders,
  setTenantRoutingSide,
} from "@/lib/db/routingPolicy";
import {
  getInstanceRoutingPolicy,
  normalizeProviderPriority,
  resolveRoutingPolicy,
} from "@/lib/routing/routingPolicy";
import { getProviderById } from "@/shared/constants/providers";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const label = (id: string) => (getProviderById(id) as { name?: string } | undefined)?.name || id;

const updateSchema = z
  .object({
    transparent: z.boolean().nullable().optional(),
    priority: z.array(z.string().trim().min(1).max(100)).max(300).nullable().optional(),
  })
  .refine((value) => value.transparent !== undefined || value.priority !== undefined, {
    message: "Nothing to update",
  });

/**
 * What this tenant may see and change. `locked` says which settings the owner keeps: the owner has the
 * last word, so a setting the owner pinned, or everything while the owner has not delegated, is locked.
 */
async function describe(tenantId: string) {
  const instance = await getInstanceRoutingPolicy();
  const row = getTenantRoutingRow(tenantId);
  return {
    effective: await resolveRoutingPolicy(tenantId),
    delegated: instance.delegated,
    locked: {
      transparent: !instance.delegated || (row?.ownerTransparent ?? null) !== null,
      priority: !instance.delegated || (row?.ownerPriority ?? null) !== null,
    },
    choice: { transparent: row?.tenantTransparent ?? null, priority: row?.tenantPriority ?? null },
    providers: listRoutableProviders(tenantId).map((entry) => ({
      id: entry.provider,
      name: label(entry.provider),
      connections: entry.connections,
    })),
  };
}

/** GET /api/tenant/routing — my tenant's policy, and which parts the owner has locked. */
export async function GET(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "admin" });
  if (auth.error) return auth.error;
  return NextResponse.json(await describe(auth.ctx!.tenantId));
}

/** PUT /api/tenant/routing — the tenant's admin sets the mode and provider order, where allowed. */
export async function PUT(request: Request) {
  const auth = await requireTenantAuth(request, { minRole: "admin" });
  if (auth.error) return auth.error;
  const tenantId = auth.ctx!.tenantId;

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
  const { transparent, priority } = validation.data;

  const state = await describe(tenantId);
  if (
    (transparent !== undefined && state.locked.transparent) ||
    (priority !== undefined && state.locked.priority)
  ) {
    return NextResponse.json(
      {
        error: {
          code: "routing_locked",
          message: "The owner controls this setting for your tenant.",
        },
      },
      { status: 403 }
    );
  }

  // Only providers this tenant can actually use may be ordered.
  let cleaned: string[] | null | undefined = undefined;
  if (priority !== undefined) {
    if (priority === null) {
      cleaned = null;
    } else {
      cleaned = normalizeProviderPriority(priority);
      const usable = new Set(state.providers.map((provider) => provider.id.toLowerCase()));
      const unknown = cleaned.filter((id) => !usable.has(id.toLowerCase()));
      if (unknown.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: "unknown_providers",
              message: "Some providers are not available to your tenant.",
              providers: unknown,
            },
          },
          { status: 400 }
        );
      }
    }
  }

  setTenantRoutingSide(tenantId, "tenant", { transparent, priority: cleaned });
  logAuditEvent({
    action: "routing.tenant.updated",
    actor: await auditActorFor(request),
    target: tenantId,
    resourceType: "tenant",
    status: "success",
    metadata: { transparent: transparent ?? undefined, providers: priority?.length },
  });
  return NextResponse.json(await describe(tenantId));
}
