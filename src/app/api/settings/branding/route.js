import fs from "node:fs";
import { NextResponse } from "next/server";
import { brandingFile, normalizeBranding, removeBranding, saveBranding } from "@/lib/branding";
import { getSettings } from "@/lib/localDb";
import { getRequestIdentity, isScopeEnabled } from "@/lib/auth/resourceScope";

export const dynamic = "force-dynamic";

// Branding is instance-wide: while resource scoping is on, only an admin edits it.
async function forbidden() {
  if (!isScopeEnabled(await getSettings())) return null;
  return (await getRequestIdentity()).isAdmin ? null : NextResponse.json({ error: "Admin access required" }, { status: 403 });
}

// Settings → Branding: the raw branding.json, validated on save.
export async function GET() {
  const denied = await forbidden();
  if (denied) return denied;
  const file = brandingFile();
  let raw = null;
  let parseError = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") parseError = e.message;
  }
  const errors = parseError ? [`branding.json is not valid JSON: ${parseError}`] : raw ? normalizeBranding(raw).errors : [];
  return NextResponse.json({ file, branding: raw, errors });
}

// Body: the branding document. ?dryRun=1 only validates.
export async function PUT(request) {
  const denied = await forbidden();
  if (denied) return denied;
  let raw;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ errors: ["Not valid JSON"] }, { status: 400 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const { value, errors } = normalizeBranding(raw);
  if (!value) return NextResponse.json({ errors }, { status: 400 });
  if (!dryRun) saveBranding(raw);
  return NextResponse.json({ saved: !dryRun, errors });
}

export async function DELETE() {
  const denied = await forbidden();
  if (denied) return denied;
  removeBranding();
  return NextResponse.json({ removed: true });
}
