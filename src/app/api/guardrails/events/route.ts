/**
 * GET /api/guardrails/events?limit&since&guardrail — recent guardrail events (block / flag / mask),
 * newest first, plus per-guardrail counts for the last 24 hours. Rows carry guardrail and rule ids
 * only, never matched text. Management-scoped via requireManagementAuth.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  GUARDRAIL_EVENT_RETENTION_MS,
  GUARDRAIL_EVENT_SUMMARY_WINDOW_MS,
  countGuardrailEvents,
  listGuardrailEvents,
} from "@/lib/db/guardrailEvents";

/** Epoch milliseconds or an ISO 8601 date/time. */
const sinceSchema = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    const trimmed = value.trim();
    const isIso = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed);
    const parsed = /^\d{1,16}$/.test(trimmed) ? Number(trimmed) : isIso ? Date.parse(trimmed) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid" });
      return z.NEVER;
    }
    return parsed;
  });

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  since: sinceSchema.optional(),
  guardrail: z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional(),
});

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    since: params.get("since") ?? undefined,
    guardrail: params.get("guardrail") ?? undefined,
  });
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid query parameters",
      type: "invalid_request",
    });
  }

  try {
    const windowStart = Date.now() - GUARDRAIL_EVENT_SUMMARY_WINDOW_MS;
    return NextResponse.json(
      {
        events: listGuardrailEvents(parsed.data),
        counts24h: countGuardrailEvents(windowStart),
        windowStart,
        retentionDays: GUARDRAIL_EVENT_RETENTION_MS / (24 * 60 * 60 * 1000),
      },
      { headers: CORS_HEADERS }
    );
  } catch {
    return createErrorResponse({
      status: 500,
      message: "Failed to read guardrail events",
      type: "server_error",
    });
  }
}
