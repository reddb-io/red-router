import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, deleteModelAlias, getModelAliasNames, setModelAliasName, getCombos } from "@/models";

export const dynamic = "force-dynamic";

// An alias is a bare model id a client calls ("fast" -> "codex/gpt-5.5"), so it cannot
// contain the "/" that separates a provider prefix, nor whitespace.
const ALIAS_PATTERN = /^[^\s/]+$/;

// GET /api/models/alias - Get all aliases and the names /v1/models shows for them
export async function GET() {
  try {
    const [aliases, names] = await Promise.all([getModelAliases(), getModelAliasNames()]);
    return NextResponse.json({ aliases, names: names || {} });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias { model, alias, name? }
export async function PUT(request) {
  try {
    const body = await request.json();
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const alias = typeof body?.alias === "string" ? body.alias.trim() : "";

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }
    if (!ALIAS_PATTERN.test(alias)) {
      return NextResponse.json({ error: `Alias "${alias}" cannot contain "/" or spaces` }, { status: 400 });
    }
    // A combo with the same name wins at routing time, so the alias would never be used.
    const combos = await getCombos();
    if ((combos || []).some((combo) => combo.name === alias)) {
      return NextResponse.json({ error: `"${alias}" is the name of a combo. Choose another alias.` }, { status: 400 });
    }

    await setModelAlias(alias, model);
    if (body?.name !== undefined) await setModelAliasName(alias, body.name);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
