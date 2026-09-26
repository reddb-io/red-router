import { createXaiAsyncVideo } from "@/app/api/v1/_shared/xaiAsyncVideo";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { handleCorsOptions } from "@/shared/utils/cors";

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return handleCorsOptions();
}

/** POST /v1/videos/extensions — xAI async video extension. */
export const POST = withInjectionGuard((request: Request) =>
  createXaiAsyncVideo(request, "extensions")
);
