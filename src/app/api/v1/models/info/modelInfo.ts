type CatalogModel = Record<string, unknown>;

const ENDPOINT_BY_KIND: Record<string, string> = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  imageToText: "/v1/chat/completions",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  rerank: "/v1/rerank",
  moderation: "/v1/moderations",
  video: "/v1/videos/generations",
  music: "/v1/music/generations",
  systemone: "/v1/systemone",
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
};

// The public voices route returns 501 for local-device: discovery there would
// execute host subprocesses and requires a separate local-only API boundary.
const VOICE_DISCOVERY_PROVIDERS = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld"]);

export function modelInfoKind(model: CatalogModel): string {
  if (model.type === "audio") {
    if (model.subtype === "speech") return "tts";
    if (model.subtype === "transcription") return "stt";
    return "audio";
  }
  if (model.type === "chat") return "llm";
  return typeof model.type === "string" && model.type ? model.type : "llm";
}

/** Project only models already visible in /v1/models to the upstream info shape. */
export function buildModelInfo(
  models: readonly CatalogModel[],
  id: string,
  requestedKind?: string
): Record<string, unknown> | null {
  const model = models.find(
    (entry) => entry.id === id && (!requestedKind || modelInfoKind(entry) === requestedKind)
  );
  if (!model) return null;

  const kind = modelInfoKind(model);
  const info: Record<string, unknown> = {
    id,
    name: typeof model.name === "string" && model.name ? model.name : id,
    kind,
    owned_by: model.owned_by ?? id.split("/")[0],
    endpoint: ENDPOINT_BY_KIND[kind] ?? null,
  };
  for (const field of [
    "params",
    "capabilities",
    "options",
    "dimensions",
    "contextWindow",
    "supported_sizes",
    "input_modalities",
    "output_modalities",
    "media_capabilities",
    "searchTypes",
    "maxResults",
  ]) {
    if (model[field] !== undefined) info[field] = model[field];
  }
  if (kind === "tts" && VOICE_DISCOVERY_PROVIDERS.has(String(info.owned_by))) {
    info.voicesUrl = `/v1/audio/voices?provider=${info.owned_by}`;
  }
  return info;
}
