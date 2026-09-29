import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { ComboInvariantError } from "@/lib/combos/invariants";
import { buildComboPresets, PRESET_SOURCES } from "@/lib/comboPresets";
import { createCombo, getCombos } from "@/lib/db/combos";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

export const dynamic = "force-dynamic";

const sourceSchema = z.enum(PRESET_SOURCES);
const applySchema = z.object({
  source: sourceSchema,
  /** Limit the run to these combo names (default: every preset that does not exist yet). */
  names: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
});

async function existingNames(): Promise<string[]> {
  return ((await getCombos()) as Array<{ name?: unknown }>)
    .map((combo) => combo.name)
    .filter((name): name is string => typeof name === "string");
}

// GET /api/combos/presets?source=cursor|claude - preview what applying the presets would create
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const source = sourceSchema.safeParse(new URL(request.url).searchParams.get("source"));
  if (!source.success) {
    return NextResponse.json({ error: "source must be cursor or claude" }, { status: 400 });
  }
  try {
    const items = buildComboPresets(source.data, await existingNames());
    return NextResponse.json({
      source: source.data,
      items,
      toCreate: items.filter((item) => !item.exists).length,
      toSkip: items.filter((item) => item.exists).length,
    });
  } catch (error) {
    console.log("Error previewing combo presets:", error);
    return NextResponse.json({ error: "Failed to preview combo presets" }, { status: 500 });
  }
}

// POST /api/combos/presets { source, names? } - create the missing preset combos
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const validation = validateBody(applySchema, await request.json().catch(() => null));
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { source, names } = validation.data;

  try {
    const wanted = names ? new Set(names) : null;
    const items = buildComboPresets(source, await existingNames()).filter(
      (item) => !item.exists && (!wanted || wanted.has(item.name))
    );
    const created: string[] = [];
    const failed: string[] = [];
    for (const item of items) {
      try {
        await createCombo({ name: item.name, models: item.models });
        created.push(item.name);
      } catch (error) {
        if (!(error instanceof ComboInvariantError)) console.log("Preset combo failed:", error);
        failed.push(item.name);
      }
    }
    return NextResponse.json({ source, created, failed, createdCount: created.length });
  } catch (error) {
    console.log("Error applying combo presets:", error);
    return NextResponse.json({ error: "Failed to apply combo presets" }, { status: 500 });
  }
}
