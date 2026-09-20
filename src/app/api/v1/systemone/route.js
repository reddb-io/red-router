import { handleSystemOne } from "@/sse/handlers/systemOne.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
/** POST /v1/systemone - native TypeSafe AI System One (JEV) endpoint. */
export async function POST(request) {
  return handleSystemOne(request);
}
