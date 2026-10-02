/** Public metadata only. This snapshot never creates connections, routes or activation. */
import seed from "./modelsDevSeed.json";
import {
  transformModelsDevToCapabilities,
  transformModelsDevToPricing,
  type ModelsDevData,
  type CapabilitiesByProvider,
  type PricingByProvider,
} from "../modelsDevSync/transform";

let capabilities: CapabilitiesByProvider | null = null;
let pricing: PricingByProvider | null = null;

export function getBundledModelsDevManifest() {
  return seed.manifest;
}

export function getBundledModelsDevPricing(): PricingByProvider {
  pricing ??= transformModelsDevToPricing(seed.providers as unknown as ModelsDevData);
  return pricing;
}

export function getBundledModelsDevCapabilities(): CapabilitiesByProvider {
  if (!capabilities) {
    capabilities = transformModelsDevToCapabilities(seed.providers as unknown as ModelsDevData);
    for (const models of Object.values(capabilities)) {
      for (const capability of Object.values(models)) {
        capability.metadata_source = "models-dev-bundled";
      }
    }
  }
  return capabilities;
}

/** Exact native ID only; vendor namespaces, versions and punctuation remain opaque. */
export function getBundledModelsDevCapability(provider: string, model: string) {
  return getBundledModelsDevCapabilities()[provider]?.[model] ?? null;
}

export function withBundledModelsDevCapabilities(
  persisted: CapabilitiesByProvider
): CapabilitiesByProvider {
  const merged: CapabilitiesByProvider = { ...getBundledModelsDevCapabilities() };
  for (const [provider, models] of Object.entries(persisted)) {
    merged[provider] = { ...merged[provider], ...models };
  }
  return merged;
}
