/** RedRouter version discovery. Installation stays with the package manager. */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { isNewer, resolveLatestVersionCached } from "@/lib/system/versionCheck";
import { APP_CONFIG } from "@/shared/constants/appConfig";

export const dynamic = "force-dynamic";

const UPDATE_GUIDANCE =
  "Update RedRouter with your package manager (mise upgrade or npm install -g @reddb-io/red-router@latest).";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const current = APP_CONFIG.version;
  const latest = await resolveLatestVersionCached({
    bypassCache: /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(req.headers.get("Cache-Control") ?? ""),
    storeResult: !/(?:^|,)\s*no-store\b/i.test(req.headers.get("Cache-Control") ?? ""),
  });
  const body = {
    current,
    latest: latest ?? "unavailable",
    updateAvailable: isNewer(latest, current),
    channel: "package-manager",
    autoUpdateSupported: false,
    autoUpdateError: UPDATE_GUIDANCE,
  };
  const serialized = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(serialized).digest("base64url")}"`;
  const headers = { "Cache-Control": "private, no-cache, must-revalidate", ETag: etag };
  const validators = req.headers
    .get("If-None-Match")
    ?.split(",")
    .map((value) => value.trim());
  if (validators?.some((value) => value === etag || value === `W/${etag}`)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(serialized, {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The inherited updater installed OmniRoute and checked out tags in-place.
  // Never mutate the operator's main worktree or switch package channels here.
  return NextResponse.json({ success: false, error: UPDATE_GUIDANCE }, { status: 409 });
}
