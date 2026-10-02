import { codexProvider } from "../config/providers/registry/codex";
import { GLM_SHARED_MODELS } from "../config/glmProvider";
import { splitCodexReasoningSuffix } from "../executors/codex/reasoningSuffix";
import { splitClaudeEffortSuffix } from "../config/providerModels";
import { isKnownClaudeEffortBaseModel } from "../utils/claudeEffortVariants";
import { usesCcWireImage } from "./ccWireImageBuiltins";
import { isDevinLiteralModelIdProvider } from "../utils/devinLiteralModelIds";

const codexIds = new Set(codexProvider.models.map((model) => model.id));

/** Parameter aliases inherit a base selection; native upstream IDs stay independent. */
export function activationModelIds(provider: string, modelId: string): string[] {
  if (provider === "codex" || provider === "codex-app-server") {
    const parsed = splitCodexReasoningSuffix(modelId);
    if (parsed.effort && codexIds.has(modelId) && codexIds.has(parsed.baseModel)) {
      return [modelId, parsed.baseModel];
    }
  }
  if (["glm", "glm-cn", "glmt"].includes(provider)) {
    for (const model of GLM_SHARED_MODELS) {
      if (model.id !== "glm-5.3" && model.id !== "glm-5.3-flash") continue;
      if (model.supportedThinkingEfforts.some((effort) => modelId === `${model.id}-${effort}`)) {
        return [modelId, model.id];
      }
    }
  }
  if (
    !["cursor", "cursor-api"].includes(provider) &&
    !isDevinLiteralModelIdProvider(provider) &&
    !provider.startsWith("openai-compatible-") &&
    (!provider.startsWith("anthropic-compatible-") ||
      provider.startsWith("anthropic-compatible-cc-")) &&
    provider !== "red-router"
  ) {
    const { baseModel, effort } = splitClaudeEffortSuffix(modelId);
    if (
      effort &&
      (provider === "claude" ||
        provider.startsWith("anthropic-compatible-cc-") ||
        usesCcWireImage(provider) ||
        isKnownClaudeEffortBaseModel(baseModel))
    )
      return [modelId, baseModel];
  }
  return [modelId];
}

// Expose parameter parsing through the service boundary used by catalog consumers.
export { splitCodexReasoningSuffix };
