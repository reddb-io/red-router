import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { flatKey } from "@/lib/flatModels.js";
import { resetFlatModelCache } from "@/sse/services/flatResolve.js";
import { resetCatalogVersions } from "@/lib/catalogVersion";

// Models page: every flat entry with all its offers, and the admin's per-model
// policy (offer order, switched-off offers) that /v1/models and routing apply.
const MAX_IDS = 200;
const MAX_ID_LENGTH = 512;

const idList = (value) => Array.isArray(value)
  && value.length <= MAX_IDS
  && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH);

function afterChange() {
  resetFlatModelCache();
  resetCatalogVersions();
}

export async function GET() {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const [entries, settings] = await Promise.all([
    buildModelsList(["llm"], { idFormat: "flat", keepEmptyFlat: true }),
    getSettings(),
  ]);
  const policies = settings.flatModelPolicies || {};
  const models = entries
    .filter((e) => e.flat)
    .map((e) => {
      const key = flatKey(e.id);
      return {
        id: e.id,
        key,
        name: e.name,
        canonical: e.canonical || null,
        offer_order: e.offer_order,
        offers: e.offers,
        policy: policies[key] || null,
      };
    });
  return NextResponse.json({ models });
}

// Body: { key, order: [offer id], disabled: [offer id] }. Empty lists clear the policy.
export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const order = body?.order ?? [];
  const disabled = body?.disabled ?? [];
  if (!key || key.length > MAX_ID_LENGTH) return NextResponse.json({ error: "key is required" }, { status: 400 });
  if (!idList(order) || !idList(disabled)) {
    return NextResponse.json({ error: `order and disabled must be lists of up to ${MAX_IDS} offer ids` }, { status: 400 });
  }
  const settings = await getSettings();
  const policies = { ...(settings.flatModelPolicies || {}) };
  if (order.length || disabled.length) {
    policies[key] = { order: [...new Set(order)], disabled: [...new Set(disabled)], updatedAt: new Date().toISOString() };
  } else {
    delete policies[key];
  }
  await updateSettings({ flatModelPolicies: policies });
  afterChange();
  return NextResponse.json({ key, policy: policies[key] || null });
}

// ?key=<flat key>: back to the default order (cheapest first), every offer on.
export async function DELETE(request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const settings = await getSettings();
  const policies = { ...(settings.flatModelPolicies || {}) };
  delete policies[key];
  await updateSettings({ flatModelPolicies: policies });
  afterChange();
  return NextResponse.json({ key, policy: null });
}
