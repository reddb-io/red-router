import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { listProvidersWithSuccessSince } from "@/lib/db/noAuthUsage";
import { getProviderConnections } from "@/lib/db/providers";
import { getSettings, updateSettings } from "@/lib/db/settings";
import {
  canonicalProviderIdOrNull,
  getNoAuthProviderInfo,
  isNoAuthProviderInSet,
  listFreeSourceProviderIds,
  listNoAuthProviderIds,
  normalizeEnabledNoAuthProviders,
} from "@/lib/providers/enabledProviders";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { errorResponse } from "@omniroute/open-sse/utils/error";
import { auditActorFor } from "@/lib/compliance/auditActor";

export const dynamic = "force-dynamic";

const LEGACY_USAGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const actionSchema = z.object({
  action: z.enum(["enable-all", "disable-all", "enable", "disable"]),
  providerIds: z
    .array(
      z
        .string()
        .max(64)
        .regex(/^[a-z0-9._-]+$/i)
    )
    .max(200)
    .optional(),
});

async function loadState() {
  const [settings, activeRows] = await Promise.all([
    getSettings(),
    getProviderConnections({ isActive: true }),
  ]);
  const enabled = new Set(normalizeEnabledNoAuthProviders(settings.enabledNoAuthProviders));
  const connected = new Set(
    (activeRows as Array<{ provider?: unknown }>)
      .map((row) => row.provider)
      .filter((p): p is string => typeof p === "string")
  );
  return { enabled, connected };
}

function describe(id: string, enabled: Set<string>, connected: Set<string>) {
  const info = getNoAuthProviderInfo(id);
  const hasConnection = connected.has(id);
  const isEnabled = isNoAuthProviderInSet(id, enabled);
  return {
    id,
    name: info.name,
    alias: info.alias,
    enabled: isEnabled,
    hasConnection,
    kind: hasConnection ? "connected" : isEnabled ? "free-optin" : "available",
  };
}

// GET /api/providers/free-sources - no-auth providers and whether the operator enabled them
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { enabled, connected } = await loadState();
    const providers = listNoAuthProviderIds().map((id) => describe(id, enabled, connected));

    // One-time hint: free sources that served successful requests in the last 90 days but are
    // not enabled now, so the UI can offer to enable them. Never enabled automatically.
    const since = new Date(Date.now() - LEGACY_USAGE_WINDOW_MS).toISOString();
    const used = new Set<string>();
    for (const raw of listProvidersWithSuccessSince(since)) {
      const canonical = canonicalProviderIdOrNull(raw);
      if (canonical) used.add(canonical);
    }
    const legacyUsage = providers
      .filter((p) => !p.enabled && !p.hasConnection && used.has(p.id))
      .map((p) => p.id);

    return NextResponse.json({ providers, legacyUsage });
  } catch {
    return errorResponse(500, "Failed to load free sources");
  }
}

// POST /api/providers/free-sources - enable / disable free sources
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const validation = validateBody(actionSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { action } = validation.data;
  const requested = normalizeEnabledNoAuthProviders(validation.data.providerIds ?? []);
  if ((action === "enable" || action === "disable") && requested.length === 0) {
    return errorResponse(400, "No valid provider ids given");
  }

  try {
    const { enabled: current } = await loadState();
    const next = new Set(current);
    if (action === "enable-all") for (const id of listFreeSourceProviderIds()) next.add(id);
    else if (action === "disable-all") next.clear();
    else if (action === "enable") for (const id of requested) next.add(id);
    else for (const id of requested) next.delete(id);

    const enabledNoAuthProviders = normalizeEnabledNoAuthProviders(Array.from(next));
    await updateSettings({ enabledNoAuthProviders });

    const auditContext = getAuditRequestContext(request);
    logAuditEvent({
      action: `provider.free_sources.${action.replace("-", "_")}`,
      actor: await auditActorFor(request),
      resourceType: "provider_free_sources",
      status: "success",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        requested: action === "enable" || action === "disable" ? requested : undefined,
        enabledCount: enabledNoAuthProviders.length,
      },
    });

    const { enabled, connected } = await loadState();
    return NextResponse.json({
      enabledNoAuthProviders,
      providers: listNoAuthProviderIds().map((id) => describe(id, enabled, connected)),
    });
  } catch {
    return errorResponse(500, "Failed to update free sources");
  }
}
