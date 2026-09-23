import { NextResponse } from "next/server";
import { getHiddenComboNames } from "@/lib/db/repos/hiddenCombosRepo.js";
import { getRequestIdentity, getScopeFilter, resolveDefaultOwner } from "@/lib/auth/resourceScope";
import { applyRecommendedCombos, previewRecommendedCombos } from "@/lib/recommendedCombos.js";

export const dynamic = "force-dynamic";

// The caller's view: which accounts feed the recommendations, who owns new combos,
// and which shared combo names they hid (free for them to reuse).
async function resolveViewer() {
  const [scopeFilter, identity, owner] = await Promise.all([getScopeFilter(), getRequestIdentity(), resolveDefaultOwner()]);
  const hidden = new Set(identity.isAdmin || !identity.owner ? [] : await getHiddenComboNames(identity.owner));
  return { scopeFilter, owner, canEditShared: identity.isAdmin, hidden };
}

function summarize(items) {
  const count = (action) => items.filter((item) => item.action === action).length;
  return { toCreate: count("create"), toUpdate: count("update"), unchanged: count("unchanged"), blocked: count("blocked") };
}

// GET /api/combos/recommended — preview the recommended default/fast/review combos
export async function GET() {
  try {
    const preview = await previewRecommendedCombos(await resolveViewer());
    return NextResponse.json({ ...preview, ...summarize(preview.items) });
  } catch (error) {
    console.log("Error previewing recommended combos:", error);
    return NextResponse.json({ error: "Failed to preview recommended combos" }, { status: 500 });
  }
}

// POST /api/combos/recommended { names?: string[] } — create or update them
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const names = Array.isArray(body?.names) ? body.names.filter((name) => typeof name === "string") : null;
    const result = await applyRecommendedCombos(await resolveViewer(), names);
    return NextResponse.json({
      ...result,
      createdCount: result.created.length,
      updatedCount: result.updated.length,
    });
  } catch (error) {
    console.log("Error applying recommended combos:", error);
    return NextResponse.json({ error: "Failed to apply recommended combos" }, { status: 500 });
  }
}
