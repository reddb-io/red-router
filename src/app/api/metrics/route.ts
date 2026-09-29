import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSettings } from "@/lib/db/settings";
import { verifyPrometheusMetricsToken } from "@/lib/db/metricsToken";
import { PROMETHEUS_CONTENT_TYPE } from "@/lib/metrics/prometheusText";
import { renderMetrics } from "@/lib/metrics/collect";

export const dynamic = "force-dynamic";

/**
 * Opt-in Prometheus scrape endpoint (text exposition v0.0.4).
 *
 * - Off (default): 404 with a fixed body, indistinguishable from a missing route.
 * - On: requires EITHER `Authorization: Bearer <scrape token>` (minted through
 *   POST /api/metrics/token) OR a management credential (dashboard session, CLI token,
 *   manage-scope API key). This route is listed as public in publicApiRoutes.ts only so the
 *   pipeline does not 401 the bearer before this handler runs — auth is enforced HERE.
 *
 * Everything is computed at scrape time; see src/lib/metrics/collect.ts.
 */

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export async function GET(request: Request) {
  let enabled = false;
  try {
    enabled = (await getSettings()).prometheusMetricsEnabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return errorResponse(404, "Not found");
  }

  const presented = bearerToken(request);
  let authorized = false;
  try {
    authorized = presented !== null && verifyPrometheusMetricsToken(presented);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
    if (authError) return authError;
  }

  try {
    const body = await renderMetrics();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": PROMETHEUS_CONTENT_TYPE,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return errorResponse(500, "Could not collect metrics");
  }
}
