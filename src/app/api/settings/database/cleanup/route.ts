import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { runScheduledCleanupPass } from "@/lib/db/cleanup";
import { getHistoryWindowDays } from "@/lib/db/historyRetentionPolicy";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

const schema = z.object({ days: z.union([z.literal(7), z.literal(14), z.literal(28)]) }).strict();

export async function POST(request: Request) {
  const auth = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (auth) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorResponse(400, "Choose a 7, 14 or 28 day window.");
  try {
    if (getHistoryWindowDays() !== parsed.data.days) {
      return errorResponse(409, "Save the retention setting before running cleanup.");
    }
    const result = await runScheduledCleanupPass("periodic");
    if (getHistoryWindowDays() !== parsed.data.days) {
      return errorResponse(
        409,
        "Retention changed during cleanup. Further deletions were stopped."
      );
    }
    if (result.totalErrors > 0) {
      return errorResponse(
        500,
        "Some history tables could not be cleaned. Inspect local diagnostic logs and retry."
      );
    }
    return NextResponse.json({
      success: true,
      days: parsed.data.days,
      deleted: result.totalDeleted,
    });
  } catch (error) {
    console.error("[Cleanup] Manual SQLite history cleanup failed:", sanitizeErrorMessage(error));
    return errorResponse(500, "SQLite cleanup failed. Inspect local diagnostic logs.");
  }
}
