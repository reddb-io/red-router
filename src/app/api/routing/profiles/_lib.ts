import { z } from "zod";
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { auditActorFor } from "@/lib/compliance/auditActor";
import { logAuditEvent } from "@/lib/compliance/index";
import {
  deleteRoutingProfile,
  RoutingProfileError,
  saveRoutingProfile,
  type RoutingProfile,
} from "@/lib/db/routingProfiles";
import { normalizeProviderPriority } from "@/lib/routing/routingPolicy";

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    transparent: z.boolean().nullable(),
    providerPriority: z.array(z.string().trim().min(1).max(100)).max(300).nullable(),
  })
  .strict()
  .refine((value) => value.transparent !== null || value.providerPriority !== null, {
    message: "Define model visibility or provider priority for this profile.",
  });

export async function mutateProfile(request: Request, operation: "save" | "delete", id?: string) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    let profile: RoutingProfile | undefined;
    if (operation === "save") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return createErrorResponse({ status: 400, message: "Invalid JSON body." });
      }
      const parsed = profileSchema.safeParse(raw);
      if (!parsed.success)
        return createErrorResponse({
          status: 400,
          message: "Provide a name and valid model visibility or provider priority.",
        });
      profile = saveRoutingProfile(
        {
          name: parsed.data.name,
          transparent: parsed.data.transparent,
          providerPriority:
            parsed.data.providerPriority === null
              ? null
              : normalizeProviderPriority(parsed.data.providerPriority),
        },
        id
      );
    } else {
      deleteRoutingProfile(id!);
    }
    logAuditEvent({
      action:
        operation === "delete"
          ? "routing.profile.deleted"
          : id
            ? "routing.profile.updated"
            : "routing.profile.created",
      actor: await auditActorFor(request),
      target: id ?? profile!.id,
      resourceType: "routing_profile",
      status: "success",
    });
    return NextResponse.json(operation === "delete" ? { deleted: true } : { profile }, {
      status: operation === "save" && !id ? 201 : 200,
    });
  } catch (error) {
    return createErrorResponse({
      status: error instanceof RoutingProfileError ? error.status : 500,
      message:
        error instanceof RoutingProfileError
          ? error.message
          : "Could not update the routing profile.",
    });
  }
}
