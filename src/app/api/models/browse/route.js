import { NextResponse } from "next/server";
import { getProviderCatalog } from "@/lib/modelCatalog/browse.js";

export const dynamic = "force-dynamic";

// GET /api/models/browse?provider=openrouter → { provider, source, models: [...] }
export async function GET(request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider) return NextResponse.json({ error: "provider required" }, { status: 400 });
  try {
    return NextResponse.json(await getProviderCatalog(provider));
  } catch (error) {
    console.log("Error browsing model catalog:", error);
    return NextResponse.json({ error: "Failed to load the model catalog" }, { status: 500 });
  }
}
