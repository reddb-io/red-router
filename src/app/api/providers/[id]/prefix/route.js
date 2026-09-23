import { NextResponse } from "next/server";
import { canSee, getScopeFilter } from "@/lib/auth/resourceScope";
import { getProviderConnectionById } from "@/models";
import { validateConnectionPrefix } from "@/lib/connectionPrefix";
import { providerIdentity } from "open-sse/providers/identity.js";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/prefix { prefix } - check a model prefix before saving it,
// so the connection editor can show why a name is unavailable.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection || !canSee(connection, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (!providerIdentity(connection.provider)) {
      return NextResponse.json({ error: "Custom providers take their prefix from the provider node" }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    const result = await validateConnectionPrefix({ prefix: body?.prefix, providerId: connection.provider, connectionId: id });
    if (result.error) return NextResponse.json({ valid: false, error: result.error });
    return NextResponse.json({ valid: true, prefix: result.prefix });
  } catch (error) {
    console.log("Error checking model prefix:", error);
    return NextResponse.json({ error: "Failed to check model prefix" }, { status: 500 });
  }
}
