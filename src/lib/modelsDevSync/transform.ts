/**
 * modelsDevSync/transform — pure data model + transform layer.
 *
 * Extracted verbatim from modelsDevSync.ts. Holds the models.dev data-model
 * types, the provider-id mapping table, and the raw→OmniRoute transform
 * functions. Zero imports, no DB access, no module state — pure functions and
 * static data. The host (modelsDevSync.ts) imports these for its sync
 * orchestration and re-exports the originally-public symbols.
 *
 * @module lib/modelsDevSync/transform
 */

export type PricingEntry = {
  input: number;
  output: number;
  cached?: number;
  cache_creation?: number;
  reasoning?: number;
  input_audio?: number;
  output_audio?: number;
};

export const MODELS_DEV_SOURCE_URL = "https://models.dev/api.json?type=all";
export const MODELS_DEV_TRANSFORM_VERSION = 2;

export type ModelsDevReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: Array<string | null> }
  | { type: "budget_tokens"; min?: number; max?: number };

export type PricingModels = Record<string, PricingEntry>;
export type PricingByProvider = Record<string, PricingModels>;

export interface ModelCapabilityEntry {
  tool_call: boolean | null;
  reasoning: boolean | null;
  attachment: boolean | null;
  structured_output: boolean | null;
  temperature: boolean | null;
  modalities_input: string; // JSON array
  modalities_output: string; // JSON array
  knowledge_cutoff: string | null;
  release_date: string | null;
  last_updated: string | null;
  status: string | null;
  family: string | null;
  open_weights: boolean | null;
  limit_context: number | null;
  limit_input: number | null;
  limit_output: number | null;
  interleaved_field: string | null;
  model_type?: string | null;
  canonical_model_id?: string | null;
  reasoning_options?: string | null; // JSON; native option values, not inferred efforts
  source_provider?: string | null;
  native_model_id?: string | null;
  metadata_source?: string;
}

export type CapabilitiesByProvider = Record<string, Record<string, ModelCapabilityEntry>>;

// ─── models.dev API types (raw) ──────────────────────────

export interface ModelsDevCost {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  input_audio?: number;
  output_audio?: number;
}

export interface ModelsDevLimit {
  context?: number;
  input?: number;
  output?: number;
}

export interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

export interface ModelsDevInterleaved {
  field?: string;
}

export interface ModelsDevModel {
  id: string;
  name: string;
  type?: string;
  canonical_model_id?: string;
  reasoning_options?: ModelsDevReasoningOption[];
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  status?: string;
  cost?: ModelsDevCost;
  limit?: ModelsDevLimit;
  modalities?: ModelsDevModalities;
  interleaved?: ModelsDevInterleaved | boolean;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

// ─── Provider mapping: models.dev provider ID → OmniRoute provider IDs/aliases ──
//
// Map only the same commercial deployment. A subscription transport, region or
// gateway is not an alias of a vendor API merely because it serves the same model.
// Keep the upstream source ID too, so its offering metadata remains addressable.

export const MODELS_DEV_PROVIDER_MAP: Record<string, string[]> = {
  // Major providers
  openai: ["openai"],
  anthropic: ["anthropic"],
  google: ["gemini"],
  "google-vertex": ["vertex"],
  // google-vertex already contains partner offerings for the main Vertex deployment.
  // Keep the Anthropic-specific transport on its own configured partner provider.
  "google-vertex-anthropic": ["vertex-partner", "vp"],
  vertex_ai: ["vertex"],
  deepseek: ["deepseek"],
  groq: ["groq"],
  xai: ["xai"],
  mistral: ["mistral"],
  togetherai: ["together"],
  together_ai: ["together"],
  "fireworks-ai": ["fireworks"],
  fireworks: ["fireworks"],
  cerebras: ["cerebras"],
  cohere: ["cohere"],
  nvidia: ["nvidia"],
  nebius: ["nebius"],
  siliconflow: ["siliconflow"],
  hyperbolic: ["hyperbolic"],
  huggingface: ["hf", "huggingface"],
  openrouter: ["openrouter"],
  perplexity: ["pplx", "perplexity"],
  // OAuth / special providers
  bedrock: ["bedrock"],
  "github-copilot": ["github", "gh"],
  kilo: ["kilocode", "kc", "kilo-gateway"],
  kilocode: ["kilocode", "kc", "kilo-gateway"],
  "kimi-for-coding": ["kimi-coding", "kmc", "kimi-coding-apikey", "kmca"],
  // The `opencode` models.dev entry used to map only to "opencode-zen" because
  // that is the historical alias pair. But OmniRoute's catalog & combo targets
  // reference models under BOTH provider IDs:
  //   - `opencode-zen/big-pickle` (alias form)
  //   - `opencode/big-pickle`    (canonical id form, used by live API catalog
  //                               and by combos like "Opencode FREE Omni")
  // If we only store synced capabilities under "opencode-zen", the canonical
  // `opencode/<model>` lookup in getCanonicalModelMetadata returns null and
  // any combo that targets `opencode/...` ends up with no computed context.
  // Symmetric mapping keeps both lookup paths populated.
  opencode: ["opencode", "opencode-zen"],
  "opencode-go": ["opencode-go"],
  // Additional providers that may overlap with OmniRoute
  alibaba: ["ali", "alibaba"],
  "alibaba-cn": ["ali-cn", "alibaba-cn", "alibaba-china"],
  "alibaba-coding-plan": ["bcp", "bailian-coding-plan"],
  zai: ["zai"],
  "zai-coding-plan": ["glm", "glmt"], // both presets use /api/coding/paas/v4
  moonshotai: ["moonshot", "kimi"],
  "moonshotai-cn": ["moonshotai-cn"],
  moonshot: ["moonshot", "kimi"],
  minimax: ["minimax"],
  "minimax-cn": ["minimax-cn"],
  longcat: ["lc", "longcat"],
  pollinations: ["pol", "pollinations"],
  cloudflare: ["cf"],
  scaleway: ["scw"],
  ollama: ["ollamacloud", "ollama-cloud"],
  blackbox: ["bb", "blackbox"],
  cline: ["cl", "cline"],
  cursor: ["cu", "cursor"],
  github: ["github-models"], // GitHub Models is not the Copilot deployment.
  // Fallback: if no mapping exists, use the models.dev ID as-is
};

/**
 * Map a models.dev provider ID to OmniRoute provider IDs.
 * Returns array of provider identifiers (may include aliases).
 */
export function mapProviderId(modelsDevProviderId: string): string[] {
  const mapped = MODELS_DEV_PROVIDER_MAP[modelsDevProviderId];
  // A known different deployment named `github` must not enrich local Copilot.
  return modelsDevProviderId === "github"
    ? [...(mapped || [])]
    : [...new Set([modelsDevProviderId, ...(mapped || [])])];
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function putOffering<T>(
  result: Record<string, Record<string, T>>,
  owners: Map<string, string>,
  provider: string,
  model: string,
  source: string,
  value: T
): void {
  const key = JSON.stringify([provider, model]);
  const previous = owners.get(key);
  if (previous && previous !== source) {
    // Fail the candidate snapshot instead of silently choosing its JSON order.
    throw new Error(`models.dev mapping collision: ${provider}/${model} (${previous}, ${source})`);
  }
  if (!Object.hasOwn(result, provider)) setOwn(result, provider, {});
  setOwn(result[provider], model, value);
  owners.set(key, source);
}

// ─── Transform: Pricing ──────────────────────────────────

/**
 * Transform models.dev raw data → OmniRoute PricingByProvider format.
 *
 * models.dev costs are already in $/1M tokens (same as OmniRoute format).
 * Maps: cache_read → cached, cache_write → cache_creation.
 */
export function transformModelsDevToPricing(raw: ModelsDevData): PricingByProvider {
  const result: PricingByProvider = {};
  const owners = new Map<string, string>();

  for (const [providerId, providerData] of Object.entries(raw).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const omniRouteProviders = mapProviderId(providerId);

    for (const [, model] of Object.entries(providerData.models || {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      const modelId = model.id;
      if (!model.cost) continue;

      // Must have at least input pricing
      if (model.cost.input == null) continue;

      const entry: PricingEntry = {
        input: model.cost.input,
        output: model.cost.output ?? 0,
      };

      if (model.cost.cache_read != null) {
        entry.cached = model.cost.cache_read;
      }
      if (model.cost.cache_write != null) {
        entry.cache_creation = model.cost.cache_write;
      }
      if (model.cost.reasoning != null) {
        entry.reasoning = model.cost.reasoning;
      }
      if (model.cost.input_audio != null) entry.input_audio = model.cost.input_audio;
      if (model.cost.output_audio != null) entry.output_audio = model.cost.output_audio;

      // Write to ALL mapped OmniRoute providers
      for (const omniProvider of omniRouteProviders) {
        putOffering(result, owners, omniProvider, modelId, providerId, entry);
      }
    }
  }

  return result;
}

// ─── Transform: Capabilities ─────────────────────────────

/**
 * Transform models.dev raw data → CapabilitiesByProvider format.
 */
export function transformModelsDevToCapabilities(raw: ModelsDevData): CapabilitiesByProvider {
  const result: CapabilitiesByProvider = {};
  const owners = new Map<string, string>();

  for (const [providerId, providerData] of Object.entries(raw).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const omniRouteProviders = mapProviderId(providerId);

    for (const [, model] of Object.entries(providerData.models || {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      const modelId = model.id;
      const modalitiesInput = model.modalities?.input ?? [];
      const modalitiesOutput = model.modalities?.output ?? [];
      // #8250: models.dev can ship attachment=false while modalities.input still
      // lists image/video (Kimi K3). Normalize at sync so persisted rows stay
      // internally consistent before resolve-time reconciliation.
      let attachment = model.attachment ?? null;
      if (
        attachment !== true &&
        modalitiesInput.some((entry) => {
          const lower = String(entry).toLowerCase();
          return lower.includes("image") || lower.includes("video");
        })
      ) {
        attachment = true;
      }

      const cap: ModelCapabilityEntry = {
        tool_call: model.tool_call ?? null,
        reasoning: model.reasoning ?? null,
        attachment,
        structured_output: model.structured_output ?? null,
        temperature: model.temperature ?? null,
        modalities_input: JSON.stringify(modalitiesInput),
        modalities_output: JSON.stringify(modalitiesOutput),
        knowledge_cutoff: model.knowledge ?? null,
        release_date: model.release_date ?? null,
        last_updated: model.last_updated ?? null,
        status: model.status ?? null,
        family: model.family ?? null,
        open_weights: model.open_weights ?? null,
        limit_context: model.limit?.context ?? null,
        limit_input: model.limit?.input ?? null,
        limit_output: model.limit?.output ?? null,
        interleaved_field:
          typeof model.interleaved === "object" && model.interleaved?.field
            ? model.interleaved.field
            : model.interleaved === true
              ? "reasoning_content"
              : null,
        model_type: model.type ?? null,
        canonical_model_id: model.canonical_model_id ?? null,
        reasoning_options: model.reasoning_options ? JSON.stringify(model.reasoning_options) : null,
        source_provider: providerId,
        native_model_id: model.id,
        metadata_source: "models-dev",
      };

      for (const omniProvider of omniRouteProviders) {
        putOffering(result, owners, omniProvider, modelId, providerId, cap);
      }
    }
  }

  return result;
}
