import { NextResponse } from "next/server";
import { getCapabilityOverrides } from "@/lib/db/index.js";
import { loadCapabilityOverrides, overrideKey, saveCapabilityOverride } from "@/lib/capabilityOverrides";
import { getBaseCapabilitiesForModel, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resetCatalogVersions } from "@/lib/catalogVersion";

export const dynamic = "force-dynamic";

// GET /api/models/capabilities                       → { overrides }
// GET /api/models/capabilities?provider=x&model=y    → { base, override, effective }
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const overrides = await getCapabilityOverrides();
    if (!model) return NextResponse.json({ overrides });
    await loadCapabilityOverrides();
    return NextResponse.json({
      base: getBaseCapabilitiesForModel(provider, model),
      override: overrides[overrideKey(provider, model)] || null,
      effective: getCapabilitiesForModel(provider, model),
    });
  } catch (error) {
    console.log("Error fetching capability overrides:", error);
    return NextResponse.json({ error: "Failed to fetch capability overrides" }, { status: 500 });
  }
}

// PUT /api/models/capabilities  body: { provider, model, capabilities: {...} | null }
export async function PUT(request) {
  try {
    const { provider = "*", model, capabilities } = await request.json();
    if (typeof model !== "string" || !model.trim()) {
      return NextResponse.json({ error: "model required" }, { status: 400 });
    }
    const saved = await saveCapabilityOverride(provider, model.trim(), capabilities);
    // /v1/models carries capabilities and parameters: its version changes now.
    resetCatalogVersions();
    return NextResponse.json({ key: overrideKey(provider, model.trim()), override: saved });
  } catch (error) {
    console.log("Error saving capability override:", error);
    return NextResponse.json({ error: "Failed to save capability override" }, { status: 500 });
  }
}
