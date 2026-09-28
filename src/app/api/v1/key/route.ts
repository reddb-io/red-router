import { clientDiscoveryDependencies } from "@/lib/clientDiscovery";
import { handleCorsOptions } from "@/shared/utils/cors";
import { handleKeyDiscovery } from "@omniroute/open-sse/handlers/clientDiscovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = handleCorsOptions;

export function GET(request: Request): Promise<Response> {
  return handleKeyDiscovery(request, clientDiscoveryDependencies);
}
