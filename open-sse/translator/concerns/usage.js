// Build OpenAI usage object. Caller computes prompt/completion/total (provider math).
// Optional details added only when > 0 (matches existing claude/gemini/codex behavior).
export function buildUsage({ promptTokens, completionTokens, totalTokens, cachedTokens = 0, cacheCreationTokens = 0, reasoningTokens = 0 }) {
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
  if (cachedTokens > 0 || cacheCreationTokens > 0) {
    usage.prompt_tokens_details = {};
    if (cachedTokens > 0) usage.prompt_tokens_details.cached_tokens = cachedTokens;
    if (cacheCreationTokens > 0) usage.prompt_tokens_details.cache_creation_tokens = cacheCreationTokens;
  }
  if (reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return usage;
}

const n = (v) => (typeof v === "number" ? v : 0);

// Chat Completions (or already-Responses) usage → Responses API usage shape.
// Without it /v1/responses never reports usage, so Responses clients (Codex CLI)
// keep their context gauge at 0 and never auto-compact.
export function toResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = [usage.input_tokens, usage.prompt_tokens].find(Number.isFinite) ?? 0;
  const output = [usage.output_tokens, usage.completion_tokens].find(Number.isFinite) ?? 0;
  const out = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : input + output,
  };
  const cached = [usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens].find(Number.isFinite);
  const reasoning = [usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens].find(Number.isFinite);
  if (Number.isFinite(cached)) out.input_tokens_details = { cached_tokens: cached };
  if (Number.isFinite(reasoning)) out.output_tokens_details = { reasoning_tokens: reasoning };
  return out;
}

// Per-provider raw token field-map + math. Returns buildUsage() args (NOT the usage object).
// Keeps each provider's exact semantics: claude/gemini fold cache+reasoning, others don't.
const USAGE_EXTRACTORS = {
  claude(raw) {
    const input = n(raw.input_tokens), output = n(raw.output_tokens);
    const cacheRead = n(raw.cache_read_input_tokens), cacheCreate = n(raw.cache_creation_input_tokens);
    const prompt = input + cacheRead + cacheCreate;
    return { promptTokens: prompt, completionTokens: output, totalTokens: prompt + output, cachedTokens: cacheRead, cacheCreationTokens: cacheCreate };
  },
  gemini(raw) {
    const cached = n(raw.cachedContentTokenCount);
    const prompt = n(raw.promptTokenCount);
    const thoughts = n(raw.thoughtsTokenCount);
    const total = n(raw.totalTokenCount);
    let candidates = n(raw.candidatesTokenCount);
    // Fallback: derive candidates from total when upstream omits it
    if (candidates === 0 && total > 0) {
      candidates = total - prompt - thoughts;
      if (candidates < 0) candidates = 0;
    }
    return { promptTokens: prompt, completionTokens: candidates + thoughts, totalTokens: total, cachedTokens: cached, reasoningTokens: thoughts };
  },
  kiro(raw) {
    const input = n(raw.inputTokens), output = n(raw.outputTokens);
    // ponytail: Amazon Q (Kiro upstream) does not expose cache fields today,
    // but pass through any cache_read/cache_creation/cached_tokens if the
    // event shape grows them later so cost tracking keeps working without
    // a second pass.
    const cached = n(raw.cache_read_input_tokens) || n(raw.cachedTokens) || n(raw.cached_tokens);
    const cacheCreation = n(raw.cache_creation_input_tokens);
    const out = { promptTokens: input, completionTokens: output, totalTokens: input + output };
    if (cached > 0) out.cachedTokens = cached;
    if (cacheCreation > 0) out.cacheCreationTokens = cacheCreation;
    return out;
  },
  ollama(raw) {
    const input = n(raw.prompt_eval_count), output = n(raw.eval_count);
    return { promptTokens: input, completionTokens: output, totalTokens: input + output };
  },
  commandcode(raw) {
    const input = n(raw.inputTokens), output = n(raw.outputTokens);
    const total = typeof raw.totalTokens === "number" ? raw.totalTokens : input + output;
    return { promptTokens: input, completionTokens: output, totalTokens: total };
  },
};

// Convert provider-native usage object → OpenAI usage. Returns null if no extractor/raw.
export function toOpenAIUsage(raw, kind) {
  const extract = USAGE_EXTRACTORS[kind];
  if (!extract || !raw || typeof raw !== "object") return null;
  return buildUsage(extract(raw));
}
