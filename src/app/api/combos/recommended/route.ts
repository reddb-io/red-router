import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { ComboInvariantError } from "@/lib/combos/invariants";
import {
  applyRecommendedCombos,
  previewRecommendedCombos,
  summarizeRecommendedItems,
  viewerFromRequest,
} from "@/lib/recommendedCombos";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";

const applySchema = z.object({
  /** Limit the run to these combos (default, fast, review). */
  names: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
});

// GET /api/combos/recommended - preview the recommended default/fast/review combos
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const preview = await previewRecommendedCombos(await viewerFromRequest(request));
    return NextResponse.json({ ...preview, ...summarizeRecommendedItems(preview.items) });
  } catch (error) {
    console.log("Error previewing recommended combos:", error);
    return NextResponse.json({ error: "Failed to preview recommended combos" }, { status: 500 });
  }
}

// POST /api/combos/recommended { names?: string[] } - create or update them
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  // An empty or absent body applies every recommended combo.
  const raw = await request.json().catch(() => ({}));
  const validation = validateBody(applySchema, raw ?? {});
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const result = await applyRecommendedCombos(
      await viewerFromRequest(request),
      validation.data.names ?? null
    );
    return NextResponse.json({
      ...result,
      createdCount: result.created.length,
      updatedCount: result.updated.length,
    });
  } catch (error) {
    if (error instanceof ComboInvariantError) {
      return NextResponse.json(
        { error: "A recommended combo is not valid for the connected accounts" },
        { status: 400 }
      );
    }
    console.log("Error applying recommended combos:", error);
    return NextResponse.json({ error: "Failed to apply recommended combos" }, { status: 500 });
  }
}
