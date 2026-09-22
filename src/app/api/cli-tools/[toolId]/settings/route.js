import { NextResponse } from "next/server";
import { getDynamicCliToolAdapter } from "@/lib/cliTools/adapters";

export const dynamic = "force-dynamic";

async function dispatch(method, request, context) {
  const { toolId } = await context.params;
  const adapter = getDynamicCliToolAdapter(toolId);
  const handler = adapter?.[method];
  if (!handler) {
    return NextResponse.json({ error: { message: "Unsupported CLI tool" } }, { status: 404 });
  }
  return handler(request, context);
}

export const GET = (request, context) => dispatch("GET", request, context);
export const PUT = (request, context) => dispatch("POST", request, context);
export const POST = (request, context) => dispatch("POST", request, context);
export const DELETE = (request, context) => dispatch("DELETE", request, context);
