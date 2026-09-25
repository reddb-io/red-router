import { NextResponse } from "next/server";
import { resetCatalogVersions } from "@/lib/catalogVersion";
import { deleteApiKey, getApiKeyById, updateApiKey, getProviderConnections } from "@/lib/localDb";
import { canSee, getRequestIdentity, getScopeFilter, normalizeOwnerInput, scopeVisible } from "@/lib/auth/resourceScope";
import { MODEL_ACCESS_MODES } from "@/lib/apiKeyPolicy.js";

const MAX_NAME_LENGTH = 100;

// Returns the accepted id list, or an { error } describing why it was rejected.
// An empty list is valid and means "unrestricted".
async function validateAllowedConnectionIds(value, filter) {
  if (value === null) return { ids: null };
  if (!Array.isArray(value)) return { error: "allowedConnectionIds must be an array or null" };
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  if (ids.length !== value.length) return { error: "allowedConnectionIds must contain non-empty strings" };
  if (ids.length === 0) return { ids: null };
  // Scoped to what the caller can see, so an unknown-id error cannot be used to
  // probe for accounts owned by someone else.
  const existing = new Set(scopeVisible(await getProviderConnections(), filter).map((c) => c.id));
  const unknown = ids.filter((id) => !existing.has(id));
  if (unknown.length) return { error: `Unknown connection ids: ${unknown.join(", ")}` };
  return { ids: Array.from(new Set(ids)) };
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key || !canSee(key, await getScopeFilter())) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, allowedConnectionIds, name, tags, owner, modelAccess, limits, modelIdFormat, mcpManageKeys } = body;

    const filter = await getScopeFilter();
    const existing = await getApiKeyById(id);
    if (!existing || !canSee(existing, filter)) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json({ error: "Name must be a non-empty string" }, { status: 400 });
      }
      updateData.name = name.trim().slice(0, MAX_NAME_LENGTH);
    }
    if (tags !== undefined) {
      if (tags !== null && !Array.isArray(tags)) {
        return NextResponse.json({ error: "tags must be an array or null" }, { status: 400 });
      }
      if (Array.isArray(tags) && tags.some((t) => typeof t !== "string")) {
        return NextResponse.json({ error: "tags must contain only strings" }, { status: 400 });
      }
      updateData.tags = tags;
    }
    if (allowedConnectionIds !== undefined) {
      const validated = await validateAllowedConnectionIds(allowedConnectionIds, filter);
      if (validated.error) return NextResponse.json({ error: validated.error }, { status: 400 });
      updateData.allowedConnectionIds = validated.ids;
    }
    if (modelIdFormat !== undefined) {
      if (!["prefixed", "flat"].includes(modelIdFormat)) {
        return NextResponse.json({ error: "modelIdFormat must be \"prefixed\" or \"flat\"" }, { status: 400 });
      }
      updateData.modelIdFormat = modelIdFormat;
    }
    if (mcpManageKeys !== undefined) {
      if (typeof mcpManageKeys !== "boolean") {
        return NextResponse.json({ error: "mcpManageKeys must be a boolean" }, { status: 400 });
      }
      updateData.mcpManageKeys = mcpManageKeys;
    }
    if (modelAccess !== undefined) {
      if (modelAccess !== null && (typeof modelAccess !== "object" || !MODEL_ACCESS_MODES.includes(modelAccess.mode))) {
        return NextResponse.json({ error: `modelAccess.mode must be one of ${MODEL_ACCESS_MODES.join(", ")}` }, { status: 400 });
      }
      if (modelAccess?.patterns !== undefined && (!Array.isArray(modelAccess.patterns) || modelAccess.patterns.some((p) => typeof p !== "string"))) {
        return NextResponse.json({ error: "modelAccess.patterns must be an array of strings" }, { status: 400 });
      }
      updateData.modelAccess = modelAccess;
    }
    if (limits !== undefined) {
      if (limits !== null && (typeof limits !== "object" || Array.isArray(limits))) {
        return NextResponse.json({ error: "limits must be an object or null" }, { status: 400 });
      }
      const bad = Object.entries(limits || {}).find(([, v]) => v !== null && v !== "" && !(Number(v) >= 0));
      if (bad) return NextResponse.json({ error: `limits.${bad[0]} must be a non-negative number` }, { status: 400 });
      updateData.limits = limits;
    }
    // Reassigning an owner is an admin action; other callers keep the current one.
    if (owner !== undefined && (await getRequestIdentity()).isAdmin) {
      updateData.owner = normalizeOwnerInput(owner);
    }

    const updated = await updateApiKey(id, updateData);

    // /v1/models changed: clients that watch X-RedRouter-Catalog-Version see it now.
    resetCatalogVersions();
    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    if (!existing || !canSee(existing, await getScopeFilter())) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
