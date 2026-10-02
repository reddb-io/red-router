import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById, getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { getRawProviderConnections } from "@/lib/db/providers";
import { describeEffectivePolicy, type AccessPolicyInput } from "@/lib/routing/effectivePolicy";
import { getModelInfo } from "@/sse/services/model";
import { resolveRoutingPolicy } from "@/lib/routing/routingPolicy";
import {
  collapseCatalogToBare,
  isChatProviderModel,
  isDecisionProviderModel,
  orderedTargetsFor,
  type CatalogEntry,
} from "@/lib/routing/bareModels";
import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";
import { markTransparentCatalogRequest } from "@/app/api/v1/models/catalogTransparency";
import { buildAliasMaps } from "@/app/api/v1/models/catalogProviderMaps";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { resolveSystemOneTarget } from "@omniroute/open-sse/handlers/systemOneCore";

const querySchema = z.object({
  apiKeyId: z.string().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(2048).optional(),
  kind: z.enum(["chat", "decision"]).default("chat"),
});

/** Read-only preview uses the exact authorized catalog, without sending a completion or decision. */
export async function GET(request: Request) {
  const auth = await requireManagementAuth(request);
  if (auth) return auth;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return NextResponse.json(buildErrorBody(400, "Invalid routing preview query."), {
      status: 400,
    });
  const { apiKeyId, model, kind } = parsed.data;
  try {
    let tenantId: string | null = null;
    let configuredAccess: AccessPolicyInput | null = null;
    let effectiveAccess: AccessPolicyInput | null = null;
    const headers = new Headers(request.headers);
    if (apiKeyId) {
      const key = await getApiKeyById(apiKeyId);
      if (!key || typeof key.key !== "string" || !(await validateApiKey(key.key)))
        return NextResponse.json(buildErrorBody(404, "Choose an active API key."), { status: 404 });
      tenantId = typeof key.tenantId === "string" ? key.tenantId : null;
      configuredAccess = key;
      effectiveAccess = await getApiKeyMetadata(key.key);
      if (!effectiveAccess)
        return NextResponse.json(buildErrorBody(503, "API key policy is unavailable."), {
          status: 503,
        });
      headers.delete("cookie");
      headers.set("authorization", `Bearer ${key.key}`);
    }
    const response = await getUnifiedModelsResponse(
      markTransparentCatalogRequest(new Request("http://localhost/v1/models", { headers }))
    );
    if (!response.ok)
      return NextResponse.json(
        buildErrorBody(503, "Authorized catalog is unavailable for this preview."),
        { status: 503 }
      );
    const catalog = (await response.json()).data as CatalogEntry[];
    const eligible = catalog.filter(
      kind === "decision" ? isDecisionProviderModel : isChatProviderModel
    );
    const policy = await resolveRoutingPolicy(tenantId);
    const { aliasToProviderId } = buildAliasMaps();
    const canonical = (provider: string) => aliasToProviderId[provider] || provider;
    const visible = policy.transparent
      ? eligible
      : collapseCatalogToBare(eligible, policy.providerPriority, canonical);
    const targets = !model
      ? []
      : policy.transparent
        ? eligible
            .filter((entry) => entry.id === model)
            .map((entry) => ({ id: String(entry.id), provider: String(entry.owned_by) }))
        : orderedTargetsFor(eligible, model, policy.providerPriority, canonical, kind);
    const connections = await getRawProviderConnections({}, undefined, undefined, [
      "id",
      "provider",
      "name",
      "is_active",
      "rate_limited_until",
      "test_status",
    ]);
    const resolvedTargets = await Promise.all(
      targets.map(async (target, index) => {
        const info =
          kind === "decision" ? resolveSystemOneTarget(target.id) : await getModelInfo(target.id);
        const entry = eligible.find((item) => item.id === target.id);
        return {
          ...target,
          position: index + 1,
          upstreamModel: typeof info?.model === "string" ? info.model : null,
          supportedEndpoints: Array.isArray(entry?.supported_endpoints)
            ? entry.supported_endpoints.filter(
                (value): value is string => typeof value === "string"
              )
            : [],
        };
      })
    );
    return NextResponse.json(
      {
        scope: { apiKeyId: apiKeyId ?? null, tenantId },
        policy,
        models: visible.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })),
        model: model ?? null,
        targets: resolvedTargets,
        effectivePolicy: describeEffectivePolicy(
          policy,
          configuredAccess,
          effectiveAccess,
          connections
        ),
        note: "Catalog order preview only. Live availability, budgets, quotas and request capabilities are checked at dispatch.",
        ...(model && !targets.length
          ? { reason: "No authorized unambiguous route for this model." }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(buildErrorBody(503, "Routing preview unavailable."), { status: 503 });
  }
}
