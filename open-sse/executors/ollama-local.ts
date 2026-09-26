import { DefaultExecutor } from "./default.ts";

/**
 * Ollama native executor — posts the translated Ollama envelope to the local
 * `/api/chat` endpoint. Legacy RedRouter behavior (native mode) instead of the
 * OpenAI-compatible `/v1` bridge.
 */
export class OllamaLocalExecutor extends DefaultExecutor {
  constructor() {
    super("ollama-local");
  }

  buildUrl(
    _model: string,
    _stream: boolean,
    _urlIndex = 0,
    credentials: Record<string, unknown> | null = null
  ): string {
    return `${resolveOllamaLocalHost(credentials)}/api/chat`;
  }

  transformRequest(
    model: string,
    body: Record<string, unknown>,
    stream: boolean
  ): Record<string, unknown> {
    return { ...body, model, stream };
  }
}

function resolveOllamaLocalHost(credentials: Record<string, unknown> | null): string {
  const psd = credentials?.providerSpecificData as Record<string, unknown> | null;
  const baseUrl = typeof psd?.baseUrl === "string" ? psd.baseUrl : null;
  const host = (baseUrl || "http://localhost:11434").replace(/\/v1\/?$/, "");
  return host;
}

export default OllamaLocalExecutor;
