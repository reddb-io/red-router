// The browse catalog kept on disk: per models.dev provider, every model with what
// the dashboard's model browser filters and sorts on. Short keys keep the file
// small (~1/3 of models.dev's api.json).
export function browseSlim(catalog) {
  const out = {};
  for (const [providerId, provider] of Object.entries(catalog || {})) {
    const models = {};
    for (const [modelId, m] of Object.entries(provider?.models || {})) {
      if (!m || typeof m !== "object") continue;
      models[modelId] = {
        n: m.name || undefined,
        f: m.family || undefined,
        d: m.release_date || undefined,
        u: m.last_updated || undefined,
        k: m.knowledge || undefined,
        r: m.reasoning || undefined,
        t: m.tool_call || undefined,
        i: (m.modalities?.input || []).filter((x) => x !== "text"),
        x: (m.modalities?.output || []).filter((x) => x !== "text"),
        nt: m.modalities?.output && !m.modalities.output.includes("text") ? true : undefined,
        c: m.limit?.context || undefined,
        o: m.limit?.output || undefined,
        w: m.open_weights || undefined,
        ci: typeof m.cost?.input === "number" ? m.cost.input : undefined,
        co: typeof m.cost?.output === "number" ? m.cost.output : undefined,
      };
    }
    out[providerId] = { n: provider?.name || providerId, m: models };
  }
  return out;
}

/**
 * The fields of an OpenRouter /models entry the browser maps, and nothing else:
 * what is stored on disk and vendored in snapshot/openrouter.json.
 */
export function slimOpenRouterModel(m) {
  return {
    id: m.id,
    name: m.name,
    created: m.created,
    context_length: m.context_length,
    pricing: { prompt: m.pricing?.prompt, completion: m.pricing?.completion },
    supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    architecture: {
      input_modalities: m.architecture?.input_modalities || [],
      output_modalities: m.architecture?.output_modalities || [],
    },
    top_provider: { context_length: m.top_provider?.context_length, max_completion_tokens: m.top_provider?.max_completion_tokens },
    description: typeof m.description === "string" ? m.description.slice(0, 280) : undefined,
  };
}
