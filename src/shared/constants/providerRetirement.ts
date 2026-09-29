/**
 * Provider ids that must remain unavailable even when stale rows are restored
 * after migrations have already run. Keep canonical ids and legacy aliases
 * together so neither executor dispatch nor credential selection can fall back.
 */
export const RUNTIME_RETIRED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "felo-web",
  "felo",
  // Keep this tombstone for restored legacy connection rows. The active Google
  // Code Assist provider is antigravity; this ID must never fall through to it.
  "gemini-cli",
  "qwen-web",
  "qw",
]);
export const RUNTIME_PROVIDER_RETIRED_ERROR_CODE = "PROVIDER_RETIRED";
export const RUNTIME_PROVIDER_RETIRED_MESSAGE = "Provider is retired and unavailable.";

type RuntimeProviderRetirementError = Error & {
  code: typeof RUNTIME_PROVIDER_RETIRED_ERROR_CODE;
  status: 410;
};

export function isRuntimeRetiredProviderId(providerId: unknown): providerId is string {
  return (
    typeof providerId === "string" &&
    RUNTIME_RETIRED_PROVIDER_IDS.has(providerId.trim().toLowerCase())
  );
}

export function assertRuntimeProviderAvailable(providerId: unknown): void {
  if (!isRuntimeRetiredProviderId(providerId)) return;

  const error = new Error(RUNTIME_PROVIDER_RETIRED_MESSAGE) as RuntimeProviderRetirementError;
  error.code = RUNTIME_PROVIDER_RETIRED_ERROR_CODE;
  error.status = 410;
  throw error;
}

/**
 * `gc/` was Gemini CLI, retired; the prefix now belongs to Grok Build. A request that still asks
 * for a Gemini model through it would reach Grok Build and fail with a confusing "model not found",
 * so it is answered with the retirement and a pointer to the provider that replaced it.
 */
const RETIRED_PREFIX_MODELS: ReadonlyArray<{ prefix: string; model: RegExp; message: string }> = [
  {
    prefix: "gc",
    model: /^gemini/i,
    message:
      "Gemini CLI (gc/) is retired and unavailable; use antigravity/<model> for Gemini models. " +
      "The gc/ prefix now belongs to Grok Build.",
  },
];

export function assertRuntimeModelProviderAvailable(modelId: unknown): void {
  if (typeof modelId !== "string") return;
  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0) return;
  const prefix = modelId.slice(0, slashIndex).trim().toLowerCase();
  const model = modelId.slice(slashIndex + 1);
  const rule = RETIRED_PREFIX_MODELS.find(
    (entry) => entry.prefix === prefix && entry.model.test(model)
  );
  if (rule) {
    const error = new Error(rule.message) as RuntimeProviderRetirementError;
    error.code = RUNTIME_PROVIDER_RETIRED_ERROR_CODE;
    error.status = 410;
    throw error;
  }
  assertRuntimeProviderAvailable(prefix);
}

export function isRuntimeProviderRetirementError(
  error: unknown
): error is RuntimeProviderRetirementError {
  if (!(error instanceof Error)) return false;
  const typed = error as Error & { code?: unknown; status?: unknown };
  return typed.code === RUNTIME_PROVIDER_RETIRED_ERROR_CODE && typed.status === 410;
}
