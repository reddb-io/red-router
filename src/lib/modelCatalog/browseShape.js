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
