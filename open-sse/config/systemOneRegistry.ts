import { REGISTRY } from "./providers/index.ts";

export interface SystemOneModel {
  id: string;
  provider: string;
  model: string;
  name: string;
}

/** Decision-only models, deliberately separate from `PROVIDER_MODELS` (chat). */
export function getAllSystemOneModels(): SystemOneModel[] {
  const models: SystemOneModel[] = [];
  for (const [provider, entry] of Object.entries(REGISTRY)) {
    for (const model of entry.systemOneConfig?.models ?? []) {
      models.push({
        id: `${provider}/${model.id}`,
        provider,
        model: model.id,
        name: model.name,
      });
    }
  }
  return models;
}

/** Management inventory supplements chat discovery without activating any model. */
export function getSystemOneModelsByProvider(providerId: string) {
  const entry = Object.values(REGISTRY).find(
    (provider) => provider.id === providerId || provider.alias === providerId
  );
  return (entry?.systemOneConfig?.models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    source: "system",
    supportedEndpoints: ["systemone", "decisions"],
  }));
}
