import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById, validateApiKey } from "@/lib/db/apiKeys";
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
    const headers = new Headers(request.headers);
    if (apiKeyId) {
      const key = await getApiKeyById(apiKeyId);
      if (!key || typeof key.key !== "string" || !(await validateApiKey(key.key)))
        return NextResponse.json(buildErrorBody(404, "Choose an active API key."), { status: 404 });
      tenantId = typeof key.tenantId === "string" ? key.tenantId : null;
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
    return NextResponse.json({
      scope: { apiKeyId: apiKeyId ?? null, tenantId },
      policy,
      models: visible.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })),
      model: model ?? null,
      targets: targets.map((target, index) => ({ ...target, position: index + 1 })),
      note: "Catalog order preview only. Live availability, budgets, quotas and request capabilities are checked at dispatch.",
      ...(model && !targets.length
        ? { reason: "No authorized unambiguous route for this model." }
        : {}),
    });
  } catch {
    return NextResponse.json(buildErrorBody(503, "Routing preview unavailable."), { status: 503 });
  }
}
