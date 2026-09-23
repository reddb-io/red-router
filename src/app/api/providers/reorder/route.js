import { NextResponse } from "next/server";
import { getProviderConnections, getSettings, setConnectionOrder } from "@/lib/localDb";
import { getRequestIdentity, getScopeFilter, isScopeEnabled, scopeVisible } from "@/lib/auth/resourceScope";

// PUT /api/providers/reorder  body: { provider, orderedIds }
// The caller's visible accounts of one provider, in their new order. They take
// the positions those accounts held before, so accounts the caller cannot see
// keep theirs. One transaction, priorities 1..N.
export async function PUT(request) {
  try {
    const { provider, orderedIds } = await request.json();
    if (typeof provider !== "string" || !provider || !Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "provider and orderedIds[] required" }, { status: 400 });
    }

    const all = await getProviderConnections({ provider });
    const visible = scopeVisible(all, await getScopeFilter());
    const visibleIds = new Set(visible.map((c) => c.id));
    if (orderedIds.length !== visibleIds.size || orderedIds.some((id) => !visibleIds.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
      return NextResponse.json({ error: "orderedIds must list each visible account of the provider once" }, { status: 400 });
    }

    // Shared accounts are ordered by the admin, as for a single-account edit.
    const identity = await getRequestIdentity();
    if (!identity.isAdmin && identity.owner && isScopeEnabled(await getSettings())
        && visible.some((c) => (c.owner ?? null) === null)) {
      return NextResponse.json({ error: "Shared accounts are managed by the admin" }, { status: 403 });
    }

    // Fill the visible accounts' current slots with the new order.
    const queue = [...orderedIds];
    const fullOrder = all.map((c) => (visibleIds.has(c.id) ? queue.shift() : c.id));
    await setConnectionOrder(provider, fullOrder);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error reordering connections:", error);
    return NextResponse.json({ error: "Failed to reorder connections" }, { status: 500 });
  }
}
