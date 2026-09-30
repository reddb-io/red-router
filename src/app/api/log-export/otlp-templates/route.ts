/**
 * API: OTLP log-export templates
 * GET — Read-only presets (Langfuse, Grafana Cloud, Honeycomb, ...) the dashboard can offer
 *       when creating an OTLP destination. Endpoint and header lines carry `<placeholders>`,
 *       never credentials. The destination form itself cannot pre-fill fields, so this route
 *       is how presets reach it.
 */

import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { OTLP_TEMPLATES } from "@/lib/logExport/otlpTemplates";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    return NextResponse.json({
      templates: OTLP_TEMPLATES.map((template) => ({ ...template })),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to list OTLP templates" },
      { status: 500 }
    );
  }
}
