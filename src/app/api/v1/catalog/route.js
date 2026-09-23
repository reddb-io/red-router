import { buildCatalog } from "@/lib/catalog.js";
import { extractApiKey } from "@/sse/services/auth.js";
import { CATALOG_VERSION_HEADER } from "open-sse/config/runtimeConfig.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/catalog - the /v1/models catalog grouped by provider, the combos, and the
 * models recommended for the caller's connected accounts. Same API-key auth, account
 * scoping and catalog version as /v1/models.
 *
 * `?for=redcode` names the client asking. It changes nothing today; it lets a later
 * version tailor the recommendations to that client without a new endpoint.
 * `?variants=expand` lists variant ids as their own entries, as on /v1/models.
 */
export async function GET(request) {
  try {
    const apiKey = extractApiKey(request);
    const variants = request?.url ? new URL(request.url).searchParams.get("variants") || undefined : undefined;
    const data = await buildCatalog({ apiKey, variants });
    return Response.json(data, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        ...(data.version ? { [CATALOG_VERSION_HEADER]: data.version } : {}),
      },
    });
  } catch (error) {
    console.log("Error building catalog:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error", param: null, code: "internal_server_error" } },
      { status: 500 },
    );
  }
}
