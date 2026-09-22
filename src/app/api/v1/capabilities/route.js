import { buildCapabilities } from "@/lib/capabilities.js";
import { extractApiKey } from "@/sse/services/auth.js";

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
 * GET /v1/capabilities - what this RedRouter instance supports, so clients can
 * detect it and opt into its routing features. Auth is the /v1 API-key gate.
 */
export async function GET(request) {
  try {
    const data = await buildCapabilities({ apiKey: extractApiKey(request) });
    return Response.json(data, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error building capabilities:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 },
    );
  }
}
