import { z } from "zod";
import {
  isOpenRouterDecisionFamilyModelId,
  isOpenRouterSystemOneModelId,
} from "@omniroute/open-sse/services/modelEndpointPolicy.ts";
import { addModelsSuffix } from "@/lib/providers/validation/urlHelpers";

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
    top_provider: z.record(z.string(), z.unknown()).optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    supported_parameters: z.array(z.string()).optional(),
  })
  .passthrough();
const responseSchema = z.object({ data: z.array(modelSchema) });

export type OpenRouterModelRecord = z.infer<typeof modelSchema>;

export function configuredOpenRouterModelsUrl(providerSpecificData: unknown): string | null {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  )
    return null;
  const data = providerSpecificData as Record<string, unknown>;
  const base = [data.baseUrl, data.customBaseUrl].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (!base) return null;
  return addModelsSuffix(base.trim().replace(/\/(?:systemone|decisions)\/?(?:[?#].*)?$/, ""));
}

export function openRouterDecisionModelsUrl(modelsUrl: string): string {
  const url = new URL(modelsUrl);
  url.searchParams.set("output_modalities", "decisions");
  return url.toString();
}

/** Public discovery is metadata, never evidence of a key's inference entitlement. */
export function parseOpenRouterModelsResponse(payload: unknown): OpenRouterModelRecord[] {
  return responseSchema.parse(payload).data;
}

export function isOpenRouterDecisionRecord(model: Record<string, unknown>): boolean {
  const architecture = model.architecture;
  return (
    Boolean(
      architecture &&
      typeof architecture === "object" &&
      !Array.isArray(architecture) &&
      Array.isArray((architecture as Record<string, unknown>).output_modalities) &&
      ((architecture as Record<string, unknown>).output_modalities as unknown[]).includes(
        "decisions"
      )
    ) || model.modelType === "decision"
  );
}

/** Keep exact native IDs, including private/alias namespaces beginning with `~`. */
export function mergeOpenRouterModelFeeds(
  chat: readonly OpenRouterModelRecord[],
  decisions: readonly OpenRouterModelRecord[]
): OpenRouterModelRecord[] {
  const merged = new Map<string, OpenRouterModelRecord>();
  for (const model of [...chat, ...decisions]) {
    const decision =
      isOpenRouterDecisionRecord(model) || isOpenRouterDecisionFamilyModelId(model.id);
    merged.set(model.id, {
      ...merged.get(model.id),
      ...model,
      nativeModelId: model.id,
      ...(decision
        ? {
            modelType: "decision",
            // A new Decisions protocol is not executable by our typed JEV adapter.
            supportedEndpoints: isOpenRouterSystemOneModelId(model.id)
              ? ["systemone", "decisions"]
              : [],
            apiFormat: isOpenRouterSystemOneModelId(model.id) ? "systemone" : "decision-native",
          }
        : {}),
    });
  }
  return [...merged.values()];
}

export async function fetchOpenRouterDecisionModels(
  modelsUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OpenRouterModelRecord[]> {
  const response = await fetchImpl(openRouterDecisionModelsUrl(modelsUrl));
  if (!response.ok) throw new Error(`OpenRouter decision catalog returned ${response.status}`);
  const models = parseOpenRouterModelsResponse(await response.json());
  if (models.some((model) => !isOpenRouterDecisionRecord(model))) {
    throw new Error("OpenRouter decision catalog contains an incompatible modality");
  }
  return models;
}

/** Both feeds must succeed before a complete global metadata snapshot is cached. */
export async function fetchOpenRouterModelFeeds(
  modelsUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OpenRouterModelRecord[]> {
  const [chat, decisions] = await Promise.all([
    (async () => {
      const response = await fetchImpl(modelsUrl);
      if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`);
      return parseOpenRouterModelsResponse(await response.json());
    })(),
    fetchOpenRouterDecisionModels(modelsUrl, fetchImpl),
  ]);
  return mergeOpenRouterModelFeeds(chat, decisions);
}
