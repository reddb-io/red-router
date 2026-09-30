import { NextResponse } from "next/server";
import { z } from "zod";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { TenantError } from "@/lib/db/tenants";

export const INVALID_JSON_BODY = buildErrorBody(400, "Invalid JSON body");

const STATUS_BY_CODE: Record<TenantError["code"], number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
};

/** TenantError messages are fixed strings written in db/tenants.ts, safe to return as-is. */
export function tenantFailure(error: unknown, fallback: string): Response {
  if (error instanceof TenantError) {
    return NextResponse.json(
      buildErrorBody(STATUS_BY_CODE[error.code], error.message, undefined, { code: error.code }),
      { status: STATUS_BY_CODE[error.code] }
    );
  }
  return NextResponse.json(buildErrorBody(500, fallback), { status: 500 });
}

export const createTenantSchema = z.object({
  slug: z.string().trim().min(2).max(32),
  name: z.string().trim().max(80).optional(),
});

export const updateTenantSchema = z
  .object({ name: z.string().trim().max(80).optional(), disabled: z.boolean().optional() })
  .refine((value) => value.name !== undefined || value.disabled !== undefined, {
    message: "Nothing to update",
  });

export const createTenantUserSchema = z.object({
  email: z.string().trim().min(3).max(254),
  displayName: z.string().trim().max(80).optional(),
  role: z.enum(["admin", "user"]).optional(),
});

export const updateTenantUserSchema = z
  .object({
    displayName: z.string().trim().max(80).optional(),
    role: z.enum(["admin", "user"]).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

const ids = z.array(z.string().trim().min(1).max(128)).max(500);
export const assignResourcesSchema = z
  .object({ connectionIds: ids.optional(), comboIds: ids.optional(), apiKeyIds: ids.optional() })
  .refine(
    (value) =>
      Boolean(value.connectionIds?.length || value.comboIds?.length || value.apiKeyIds?.length),
    { message: "Nothing to assign" }
  );

export const sharedResourceSchema = z.object({
  kind: z.enum(["connection", "combo"]),
  id: z.string().trim().min(1).max(128),
  shared: z.boolean(),
});
