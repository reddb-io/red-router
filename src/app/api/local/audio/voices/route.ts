import { z } from "zod";

import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { listLocalDeviceVoices } from "@/lib/audio/localDeviceVoices";
import { canUseHostSpeech } from "@/lib/security/hostSpeechAccess";
import { isLocalRequestAllowed } from "@/lib/security/localEndpoints";

const querySchema = z.object({
  lang: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/)
    .optional(),
});

export const dynamic = "force-dynamic";

/** Host-voice discovery belongs behind the local-only API, never public /v1. */
export async function GET(request: Request): Promise<Response> {
  const local = isLocalRequestAllowed();
  if (!local.allowed || !canUseHostSpeech(request)) {
    return errorResponse(403, "Local voice discovery requires a loopback request");
  }
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return errorResponse(501, "Local voice discovery requires macOS or Windows");
  }
  const url = new URL(request.url);
  const query = querySchema.safeParse({ lang: url.searchParams.get("lang") ?? undefined });
  if (!query.success) return errorResponse(400, "Invalid voice language");

  try {
    const voices = await listLocalDeviceVoices();
    const lang = query.data.lang?.toLowerCase();
    const data = lang
      ? voices.filter((voice) =>
          lang.includes("-")
            ? voice.locale.toLowerCase() === lang
            : voice.lang.toLowerCase() === lang
        )
      : voices;
    return Response.json({ object: "list", data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse(502, "Local voice catalog unavailable");
  }
}
