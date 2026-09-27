import { z } from "zod";

import { handleCorsOptions } from "@/shared/utils/cors";
import { errorResponse } from "@omniroute/open-sse/utils/error";
import { getUnifiedModelsResponse } from "../catalog";
import { buildModelInfo } from "./modelInfo";

const querySchema = z.object({
  id: z.string().min(1).max(512),
  kind: z
    .enum([
      "llm",
      "image",
      "imageToText",
      "tts",
      "stt",
      "embedding",
      "rerank",
      "moderation",
      "video",
      "music",
      "systemone",
      "webSearch",
      "webFetch",
    ])
    .optional(),
});

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return handleCorsOptions();
}

/** GET /v1/models/info?id=provider/model[&kind=tts] */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    id: url.searchParams.get("id"),
    kind: url.searchParams.get("kind") ?? undefined,
  });
  if (!parsed.success) return errorResponse(400, "Invalid model info query");

  // The unified catalog owns auth, model visibility, connection eligibility and
  // aliases; never expose static registry entries that the caller cannot list.
  const catalogResponse = await getUnifiedModelsResponse(request);
  if (!catalogResponse.ok) return catalogResponse;

  const catalog = (await catalogResponse.json()) as { data?: Record<string, unknown>[] };
  const info = buildModelInfo(
    Array.isArray(catalog.data) ? catalog.data : [],
    parsed.data.id,
    parsed.data.kind
  );
  if (!info) return errorResponse(404, `Model not found: ${parsed.data.id}`);

  const headers = new Headers(catalogResponse.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(info), { status: 200, headers });
}
