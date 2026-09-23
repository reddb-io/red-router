import { NextResponse } from "next/server";
import { getModelDisplayNames, setModelDisplayName } from "@/models";
import { getModelInfo } from "@/sse/services/model.js";

export const dynamic = "force-dynamic";

// A display name belongs to the provider's model, whatever prefix the dashboard used:
// "cc/claude-x", "claude/claude-x" and a connection prefix all key "<providerId>/claude-x".
async function modelKey(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value.includes("/")) return null;
  const info = await getModelInfo(value);
  return info?.provider && info.model ? `${info.provider}/${info.model}` : null;
}

// GET /api/models/names - display names keyed by "<providerId>/<modelId>"
export async function GET() {
  try {
    return NextResponse.json({ names: (await getModelDisplayNames()) || {} });
  } catch (error) {
    console.log("Error fetching model names:", error);
    return NextResponse.json({ error: "Failed to fetch model names" }, { status: 500 });
  }
}

// PUT /api/models/names { model: "<prefix>/<modelId>", name } - an empty name clears it
export async function PUT(request) {
  try {
    const body = await request.json();
    const key = await modelKey(body?.model);
    if (!key) return NextResponse.json({ error: "A provider model id (\"<prefix>/<model>\") is required" }, { status: 400 });
    await setModelDisplayName(key, body?.name);
    return NextResponse.json({ success: true, key });
  } catch (error) {
    console.log("Error updating model name:", error);
    return NextResponse.json({ error: "Failed to update model name" }, { status: 500 });
  }
}

// DELETE /api/models/names?model=<prefix>/<modelId>
export async function DELETE(request) {
  try {
    const key = await modelKey(new URL(request.url).searchParams.get("model"));
    if (!key) return NextResponse.json({ error: "A provider model id is required" }, { status: 400 });
    await setModelDisplayName(key, "");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting model name:", error);
    return NextResponse.json({ error: "Failed to delete model name" }, { status: 500 });
  }
}
