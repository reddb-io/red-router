import { z } from "zod";
import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy";

const capabilitySchema = z.enum([
  "chat",
  "decision",
  "reasoning",
  "tools",
  "vision",
  "structured-output",
]);
export type CatalogCapability = z.infer<typeof capabilitySchema>;
type CatalogModel = Record<string, unknown>;

/** Repeated parameters and comma-separated values both mean all requested capabilities. */
export function parseCatalogCapabilities(request: Request) {
  const values = new URL(request.url).searchParams
    .getAll("capabilities")
    .flatMap((value) => value.split(",").map((item) => item.trim()));
  return z.array(capabilitySchema).max(12).safeParse(values);
}

export function catalogCapabilityCacheKey(request: Request): string {
  const parsed = parseCatalogCapabilities(request);
  return parsed.success ? [...new Set(parsed.data)].sort().join(",") : "invalid";
}

/** Decisions are a separate protocol; chat metadata heuristics must never turn JEV into S2. */
export function withCatalogRoleCapabilities(model: CatalogModel): CatalogModel {
  const declared = Array.isArray(model.supported_endpoints)
    ? model.supported_endpoints.filter(
        (endpoint): endpoint is string => typeof endpoint === "string"
      )
    : undefined;
  const id = typeof model.id === "string" ? model.id : "";
  const provider = typeof model.owned_by === "string" ? model.owned_by : undefined;
  const rawModel = typeof model.root === "string" ? model.root : id.slice(id.indexOf("/") + 1);
  const endpoint = getModelEndpointDecision(provider, rawModel, declared);
  const decision = model.type === "systemone" || endpoint.kind === "systemone";
  const chat =
    !decision &&
    (!model.type || ["chat", "llm", "imageToText"].includes(String(model.type))) &&
    endpoint.chatSelectable;
  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? { ...(model.capabilities as CatalogModel) }
      : {};
  capabilities.chat = chat;
  capabilities.decision = decision;
  if (decision) {
    capabilities.tool_calling = false;
    capabilities.reasoning = false;
    capabilities.vision = false;
    capabilities.thinking = false;
    capabilities.supportsThinking = false;
    delete capabilities.effort_tiers;
  }
  return {
    ...model,
    ...(decision ? { type: "systemone", supported_endpoints: ["systemone", "decisions"] } : {}),
    capabilities,
  };
}

const CAPABILITY_FIELDS: Record<CatalogCapability, string> = {
  chat: "chat",
  decision: "decision",
  reasoning: "reasoning",
  tools: "tool_calling",
  vision: "vision",
  "structured-output": "structured_output",
};

/** Apply only to the already authorized catalog, before pagination. Unknown support is not true. */
export function filterCatalogCapabilities<T extends CatalogModel>(
  models: T[],
  requested: readonly CatalogCapability[]
): T[] {
  if (!requested.length) return models;
  return models.filter((model) => {
    const capabilities = model.capabilities as CatalogModel | undefined;
    return requested.every((capability) => capabilities?.[CAPABILITY_FIELDS[capability]] === true);
  });
}
