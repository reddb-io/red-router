import { z } from "zod";

import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { resolvePublicCred } from "@omniroute/open-sse/utils/publicCreds.ts";
import { isConnectionUnavailableToAuxiliaryActivity } from "@/lib/exclusiveLeaseIsolation";
import { normalizeVoices, type VoiceProvider } from "./voiceCatalog";

const querySchema = z.object({
  provider: z.enum(["elevenlabs", "deepgram", "inworld", "edge-tts", "local-device"]),
  lang: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/)
    .optional(),
});

const URLS: Record<VoiceProvider, string> = {
  elevenlabs: "https://api.elevenlabs.io/v1/voices",
  deepgram: "https://api.deepgram.com/v1/models",
  inworld: "https://api.inworld.ai/tts/v1/voices",
  "edge-tts": "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list",
};

type Credentials = {
  connectionId?: string;
  apiKey?: string | null;
  accessToken?: string | null;
  allExpired?: boolean;
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return handleCorsOptions();
}

/** GET /v1/audio/voices?provider=...&lang=... */
export async function GET(request: Request): Promise<Response> {
  const auth = await enforceClientApiRouteAuth(request);
  if (auth) return withCors(auth);

  const url = new URL(request.url);
  const query = querySchema.safeParse({
    provider: url.searchParams.get("provider"),
    lang: url.searchParams.get("lang") ?? undefined,
  });
  if (!query.success) return withCors(errorResponse(400, "Invalid voice provider or language"));

  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return withCors(policy.rejection);

  if (query.data.provider === "local-device") {
    // Local discovery invokes host subprocesses on macOS/Windows. Keep this
    // public client API cloud-safe; a separate LOCAL_ONLY endpoint is needed.
    return withCors(errorResponse(501, "Local-device voice discovery is unavailable on this API"));
  }

  const provider = query.data.provider;
  let credentials: Credentials | null = null;
  let token = "";
  if (provider !== "edge-tts") {
    credentials = (await getProviderCredentialsWithQuotaPreflight(provider)) as Credentials | null;
    if (isAllRateLimitedCredentials(credentials)) {
      return withCors(rateLimitedProviderResponse(provider, credentials));
    }
    token = credentials?.apiKey || credentials?.accessToken || "";
    if (!token || credentials?.allExpired) {
      return withCors(errorResponse(401, `No credentials for provider: ${provider}`));
    }
    if (
      credentials?.connectionId &&
      (await isConnectionUnavailableToAuxiliaryActivity(credentials.connectionId))
    ) {
      return withCors(errorResponse(409, "Voice discovery connection is leased"));
    }
  }

  const upstreamUrl = new URL(URLS[provider]);
  if (provider === "edge-tts") {
    upstreamUrl.searchParams.set("trustedclienttoken", resolvePublicCred("edge_tts_id"));
  }
  const headers = new Headers({ Accept: "application/json" });
  if (provider === "elevenlabs") headers.set("xi-api-key", token);
  if (provider === "deepgram") headers.set("Authorization", `Token ${token}`);
  if (provider === "inworld") headers.set("Authorization", `Basic ${token}`);

  try {
    const upstream = await fetch(upstreamUrl, {
      headers,
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    if (!upstream.ok) {
      // Upstream bodies can include account data and stack traces.
      return withCors(errorResponse(502, `${provider} voice catalog unavailable`));
    }
    const voices = normalizeVoices(provider, await upstream.json());
    if (credentials) await clearRecoveredProviderState(credentials as Record<string, unknown>);
    const data = query.data.lang
      ? voices.filter((voice) => voice.lang.toLowerCase() === query.data.lang?.toLowerCase())
      : voices;
    return Response.json({ object: "list", data }, { headers: CORS_HEADERS });
  } catch {
    return withCors(errorResponse(502, `${provider} voice catalog unavailable`));
  }
}
