/** Ollama Cloud's hosted web_fetch endpoint, separate from local Ollama search. */
import { z } from "zod";

import { buildErrorBody } from "../utils/error.ts";
import type { WebFetchCredentials, WebFetchFormat, WebFetchResult } from "../handlers/webFetch.ts";

const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CHARACTERS = 200_000;
const OllamaFetchSchema = z.object({
  content: z.string(),
  title: z.string().nullable().optional(),
  links: z.array(z.string()).max(1000).optional(),
});

function failure(status: number, message: string): WebFetchResult {
  const body = buildErrorBody(status, message);
  return { success: false, status, error: body.error.message };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Ollama Cloud web fetch response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("Ollama Cloud web fetch response exceeded limit");
        throw new Error("Ollama Cloud web fetch response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function ollamaCloudFetch({
  url,
  format,
  includeMetadata,
  credentials,
}: {
  url: string;
  format: WebFetchFormat;
  includeMetadata: boolean;
  credentials: WebFetchCredentials;
}): Promise<WebFetchResult> {
  if (!credentials.apiKey) return failure(401, "Ollama Cloud API key required");
  if (format !== "markdown") {
    return failure(400, "Ollama Cloud web fetch supports only markdown text");
  }
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return failure(400, "Ollama Cloud web fetch requires an HTTP or HTTPS URL");
    }
  } catch {
    return failure(400, "Ollama Cloud web fetch requires a valid URL");
  }

  try {
    const response = await fetch(OLLAMA_WEB_FETCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return failure(response.status, `Ollama Cloud web fetch returned HTTP ${response.status}`);
    }
    const parsed = OllamaFetchSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return failure(502, "Ollama Cloud web fetch returned an invalid result");
    return {
      success: true,
      data: {
        provider: "ollama-cloud",
        url,
        content: parsed.data.content.slice(0, MAX_CHARACTERS),
        links: parsed.data.links || [],
        metadata: includeMetadata ? { title: parsed.data.title || null, description: null } : null,
        screenshot_url: null,
      },
    };
  } catch (error) {
    return failure(
      error instanceof Error && error.name === "TimeoutError" ? 504 : 502,
      "Ollama Cloud web fetch failed"
    );
  }
}
