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
