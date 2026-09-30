import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { clearDispatcherCache } from "@omniroute/open-sse/utils/proxyDispatcher";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance";
import { PROXY_PRESETS, summarizeProxyPreset } from "@/lib/proxyPresets/catalog";
import { ProxyPresetError, applyProxyPreset } from "@/lib/proxyPresets/apply";

const NO_STORE = { "Cache-Control": "no-store" };

/** Best-effort audit entry. Never carries the params, the username or the password. */
function auditPreset(
  request: Request,
  status: "success" | "failure",
  target: string,
  details: Record<string, unknown>
): void {
  try {
    const { ipAddress, requestId } = getAuditRequestContext(request);
    logAuditEvent({
      action: "proxy.preset.apply",
      actor: "dashboard",
      target,
      resourceType: "proxy_registry",
      status,
      details,
      ipAddress: ipAddress || undefined,
      requestId: requestId || undefined,
    });
  } catch {
    /* audit is best effort */
  }
}

/**
 * GET /api/settings/proxy-presets: the preset catalog as descriptors (what to ask the operator for).
 * No credentials, no build functions.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return Response.json({ items: PROXY_PRESETS.map(summarizeProxyPreset) }, { headers: NO_STORE });
}

/**
 * POST /api/settings/proxy-presets { presetId, name, params }: composes the preset into a registry
 * proxy and stores it through the registry's own upsert. Returns the registry's redacted view.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const presetId =
    raw && typeof raw === "object" && typeof (raw as { presetId?: unknown }).presetId === "string"
      ? String((raw as { presetId: string }).presetId).slice(0, 64)
      : "";

  try {
    const applied = await applyProxyPreset(raw);
    if (applied.action === "updated") clearDispatcherCache();
    auditPreset(request, "success", applied.proxy.id, {
      presetId: applied.preset.id,
      name: applied.proxy.name,
      host: applied.proxy.host,
      port: applied.proxy.port,
      sticky: applied.sticky,
      action: applied.action,
    });
    return Response.json(
      { proxy: applied.proxy, action: applied.action, sticky: applied.sticky },
      { status: applied.action === "created" ? 201 : 200, headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof ProxyPresetError) {
      auditPreset(request, "failure", "proxy-preset", { reason: error.code });
      return errorResponse(error.code === "unknown_preset" ? 404 : 400, error.message);
    }
    // Managed-source conflicts and other registry errors carry a status and a fixed message.
    const known = error as { status?: unknown; code?: unknown; message?: unknown } | null;
    if (known?.status === 409 && known.code === "proxy_managed") {
      return errorResponse(
        409,
        "This proxy is managed by RedRouter and cannot be changed manually"
      );
    }
    console.error("[proxy-presets] apply failed", error instanceof Error ? error.name : "error");
    auditPreset(request, "failure", presetId || "proxy-preset", { reason: "server_error" });
    return errorResponse(500, "Failed to add the proxy preset");
  }
}
