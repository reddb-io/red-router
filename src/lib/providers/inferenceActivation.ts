import { errorResponse } from "@omniroute/open-sse/utils/error";
import { isProbeContext } from "@/shared/utils/probeOrigin";
import { getModelIsHidden } from "@/lib/db/models";
import { isProviderEnabledNow } from "./enabledProvidersAccessor";

/** Management discovery and direct health probes do not pass through inference admission. */
export async function getInferenceActivationRejection(
  providerId: string,
  modelId: string,
  modality: string,
  credentialProviderId: string = providerId
): Promise<Response | null> {
  if (!isProbeContext() && getModelIsHidden(providerId, modelId, modality)) {
    return errorResponse(403, "Model is inactive. Activate it in the provider's model list.");
  }
  if (!(await isProviderEnabledNow(credentialProviderId))) {
    return errorResponse(403, "Provider is inactive. Enable a connection before using this model.");
  }
  return null;
}
