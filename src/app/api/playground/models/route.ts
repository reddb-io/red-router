import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";
import { markDashboardCatalogRequest } from "@/app/api/v1/models/catalogTransparency";

/** Management-only catalog for provider selection, independent of client transparency. */
export async function GET(request: Request): Promise<Response> {
  const rejection = await requireManagementAuth(request);
  if (rejection) return rejection;
  return getUnifiedModelsResponse(markDashboardCatalogRequest(request));
}
