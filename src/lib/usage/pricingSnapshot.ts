/** Recording-time model prices. Null means unavailable, never a free price. */
export interface UsagePricingSnapshot {
  currency: "USD";
  unit: "million-tokens";
  source: "router-model-pricing";
  capturedAt: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  serviceTierMultiplier: number;
}

export function snapshotModelPricing(
  pricing: Record<string, unknown>, capturedAt: string, serviceTierMultiplier = 1
): UsagePricingSnapshot {
  const price = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const input = price(pricing.input), output = price(pricing.output);
  return {
    currency: "USD", unit: "million-tokens", source: "router-model-pricing", capturedAt,
    input, output, cacheRead: price(pricing.cached) ?? input,
    cacheWrite: price(pricing.cache_creation) ?? input,
    reasoning: price(pricing.reasoning) ?? output, serviceTierMultiplier,
  };
}
