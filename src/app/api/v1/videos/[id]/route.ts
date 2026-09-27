import { getXaiAsyncVideo } from "@/app/api/v1/_shared/xaiAsyncVideo";
import { handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return handleCorsOptions();
}

/** GET /v1/videos/{id} — poll a durable, connection-pinned async job. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return getXaiAsyncVideo(request, id);
}
