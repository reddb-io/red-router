import { buildModelsList } from "../route.js";
import { catalogFetchOptions } from "@/lib/remoteRouterCatalog";
import { catalogEntryFor } from "@/lib/catalogEntry";
import { extractApiKey } from "@/sse/services/auth.js";
import { getCatalogVersion } from "@/lib/catalogVersion";
import { CATALOG_VERSION_HEADER } from "open-sse/config/runtimeConfig.js";
import { RED_ROUTER_INSTANCE_HEADER, RED_ROUTER_INSTANCE_ID } from "open-sse/config/redRouter.js";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
  "systemone": ["systemone"],
  "text-classification": ["systemone"],
};

const LLM_KIND = "llm";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function json(data, options = {}) {
  return Response.json(data, {
    ...options,
    headers: {
      "Access-Control-Allow-Origin": "*",
      ...options.headers,
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * GET /v1/models/{provider}/{model} - OpenAI-compatible single model lookup.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web, text-classification.
 */
export async function GET(request, { params }) {
  try {
    const { model } = await params;
    const path = Array.isArray(model) ? model : [model];
    const identifier = path.filter(Boolean).join("/");
    const kindFilter = path.length === 1 ? KIND_SLUG_MAP[identifier] : null;

    const apiKey = extractApiKey(request);
    const variants = request?.url ? new URL(request.url).searchParams.get("variants") || undefined : undefined;

    if (kindFilter) {
      // Another RedRouter reading this catalog sends its hop chain (see catalogFetchOptions).
      const data = await buildModelsList(kindFilter, { ...catalogFetchOptions(request), apiKey, variants });
      return json({ object: "list", data }, { headers: { [RED_ROUTER_INSTANCE_HEADER]: RED_ROUTER_INSTANCE_ID } });
    }

    // Match the same LLM catalog exposed by GET /v1/models. A catch-all
    // parameter is required because provider-prefixed IDs contain a slash.
    const models = await buildModelsList([LLM_KIND], { apiKey, variants });
    // A legacy id ("cc/<model>") still finds its entry through `aliases`, a variant
    // id ("codex/gpt-5.5-review") the base entry it is folded into, and a user alias
    // ("fast") its own entry.
    const matchedModel = catalogEntryFor(models, identifier);

    if (!matchedModel) {
      return json(
        {
          error: {
            message: `The model '${identifier}' does not exist or you do not have access to it.`,
            type: "invalid_request_error",
            param: null,
            code: "model_not_found",
          },
        },
        { status: 404 },
      );
    }

    // One model's full parameters (a combo's include its members); the version lets a
    // client tell whether what it cached from /v1/models is still current.
    const catalogVersion = await getCatalogVersion(apiKey);
    return json(matchedModel, catalogVersion ? { headers: { [CATALOG_VERSION_HEADER]: catalogVersion } } : {});
  } catch (error) {
    console.log("Error fetching model:", error);
    return json(
      { error: { message: error.message, type: "server_error", param: null, code: "internal_server_error" } },
      { status: 500 },
    );
  }
}
