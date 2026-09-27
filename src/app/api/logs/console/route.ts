/**
 * Console Log API — GET /api/logs/console
 *
 * Reads the application log file and returns entries from the last 1 hour.
 * Supports filtering by level and limiting the number of entries.
 *
 * Query params:
 *   - level: minimum log level (debug|info|warn|error) — default: all
 *   - limit: max entries to return — default: 500
 *   - component: filter by component/module name
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { getAppLogFilePath } from "@/lib/logEnv";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { parseConsoleLogLine, type ConsoleLogEntry } from "@/lib/consoleLogEntries";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

function getLogFilePath(): string {
  return getAppLogFilePath();
}

export async function GET(req: NextRequest) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const levelFilter = searchParams.get("level") || "all";
    const rawLimit = parseInt(searchParams.get("limit") || "500", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500, 2000);
    const componentFilter = searchParams.get("component") || "";

    const logPath = getLogFilePath();

    if (!existsSync(logPath)) {
      return NextResponse.json([], { status: 200 });
    }

    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const filter = {
      level: levelFilter,
      component: componentFilter,
      since: Date.now() - 60 * 60 * 1000,
    };
    const entries: ConsoleLogEntry[] = [];

    for (const line of lines) {
      const entry = parseConsoleLogLine(line, filter);
      if (entry) entries.push(entry);
    }

    // Return last N entries (most recent)
    const result = entries.slice(-limit);

    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(err?.message) || "Failed to read logs" },
      { status: 500 }
    );
  }
}
