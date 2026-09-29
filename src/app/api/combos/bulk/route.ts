import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { runComboBulk } from "@/lib/comboBulk";
import { isCloudEnabled } from "@/lib/db/settings";
import { syncToCloud } from "@/lib/cloudSync";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { comboStrategySchema } from "@/shared/validation/schemas/combo";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";

const idsSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(200);
const bulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), ids: idsSchema }),
  z.object({ action: z.literal("setStrategy"), ids: idsSchema, strategy: comboStrategySchema }),
]);

// POST /api/combos/bulk { action: "delete" | "setStrategy", ids, strategy? }
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const validation = validateBody(bulkSchema, await request.json().catch(() => null));
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { ids, ...action } = validation.data;

  try {
    const result = await runComboBulk(ids, action);
    if (result.succeeded > 0) {
      try {
        if (await isCloudEnabled()) await syncToCloud(await getConsistentMachineId());
      } catch (error) {
        console.log("Cloud sync after bulk combo change failed:", error);
      }
    }
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error running bulk combo action:", error);
    return NextResponse.json({ error: "Failed to run the bulk action" }, { status: 500 });
  }
}
