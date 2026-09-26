import { handleCorsOptions } from "@/shared/utils/cors";
import { handleSystemOne } from "@/sse/handlers/systemOne";

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return handleCorsOptions();
}

/** Typed System One evaluations use their own protocol, separate from chat. */
export async function POST(request: Request): Promise<Response> {
  return handleSystemOne(request);
}
