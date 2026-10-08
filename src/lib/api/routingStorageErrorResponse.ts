import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { RoutingStorageError } from "@/lib/db/repositories/routingStorageConfig";

export function routingStorageErrorResponse(error: unknown): Response | null {
  if (!(error instanceof RoutingStorageError)) return null;
  return Response.json(
    buildErrorBody(error.status, error.message, undefined, {
      code: `routing_storage_${error.code}`,
    }),
    { status: error.status }
  );
}
