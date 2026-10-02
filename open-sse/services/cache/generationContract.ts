import { createHash } from "node:crypto";

// Older entries cannot prove which generation parameters produced their response.
export const CACHE_SIGNATURE_VERSION = 2;

export interface GenerationContract extends Record<string, unknown> {
  toolChoice?: unknown;
  tools?: unknown;
  responseFormat?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  text_format?: unknown;
}

const GENERATION_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "response_format",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "output_config",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "top_k",
  "seed",
  "stop",
  "stop_sequences",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "logit_bias",
  "n",
  "best_of",
  "logprobs",
  "top_logprobs",
  "text",
  "verbosity",
  "modalities",
  "audio",
  "prediction",
  "instructions",
  "system",
  "options",
  "chat_template_kwargs",
  "generationConfig",
  "generation_config",
  "extra_body",
  "provider_options",
  "response_schema",
  "response_mime_type",
  "web_search_options",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parameters whose values determine whether a cached answer satisfies a request. */
export function outputContractOf(body: unknown): GenerationContract | null {
  const input = record(body);
  const contract: GenerationContract = {};
  for (const field of GENERATION_FIELDS) {
    if (input[field] != null) contract[field] = input[field];
  }
  // Preserve the public helper's legacy aliases for callers using either spelling.
  if (contract.tool_choice != null) contract.toolChoice = contract.tool_choice;
  if (contract.response_format != null) contract.responseFormat = contract.response_format;
  const text = record(input.text);
  if (text.format != null) contract.text_format = text.format;
  return Object.keys(contract).length ? contract : null;
}

/** Normalize aliases without discarding provider-specific tool policies or schemas. */
export function normalizeGenerationContract(value?: GenerationContract | null): GenerationContract {
  const normalized = { ...value };
  if (value?.toolChoice != null) normalized.tool_choice = value.toolChoice;
  if (value?.responseFormat != null) normalized.response_format = value.responseFormat;
  if (value?.text_format != null) {
    normalized.text = { ...record(normalized.text), format: value.text_format };
  }
  delete normalized.text_format;
  delete normalized.toolChoice;
  delete normalized.responseFormat;
  return normalized;
}

/** Stable object-key order; array order remains significant for tools and stop sequences. */
export function canonicalCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCacheValue);
  if (value && typeof value === "object") {
    const input = record(value);
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, canonicalCacheValue(input[key])])
    );
  }
  return value;
}

/** Partition fuzzy candidates independently of their prompt similarity or verifier. */
export function generationContractHash(body: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalCacheValue({
          version: CACHE_SIGNATURE_VERSION,
          temperature: body.temperature ?? null,
          top_p: body.top_p ?? null,
          contract: normalizeGenerationContract(outputContractOf(body)),
        })
      )
    )
    .digest("hex");
}
