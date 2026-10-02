import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy";
import { isModelSelectable } from "@omniroute/open-sse/services/modelLifecycle";
import { resolveSystemOneTarget } from "@omniroute/open-sse/handlers/systemOneCore.ts";

type CatalogModelPolicyInput = {
  id: string;
  supportedEndpoints?: readonly string[];
  modelType?: unknown;
  apiFormat?: unknown;
};

/** Endpoint declarations cannot add an adapter the router does not implement. */
export function isImplementedCatalogDecisionSource(
  provider: string,
  model: CatalogModelPolicyInput
): boolean {
  if (model.apiFormat === "decision-native") return false;
  const endpoint = getModelEndpointDecision(provider, model.id, model.supportedEndpoints);
  if (endpoint.kind !== "systemone") return false;
  return Boolean(
    resolveSystemOneTarget(`${provider === "red-router" ? "red" : provider}/${model.id}`)
  );
}

export function isUnifiedChatSourceModelSelectable(
  provider: string,
  model: CatalogModelPolicyInput
): boolean {
  // Unified discovery retains other specialty surfaces, but an unimplemented
  // Decisions protocol must remain solely in the administrative inventory.
  if (model.modelType === "decision" || model.apiFormat === "decision-native") return false;
  return (
    isModelSelectable(provider, model.id) &&
    getModelEndpointDecision(provider, model.id, model.supportedEndpoints).reason !==
      "provider-policy"
  );
}
