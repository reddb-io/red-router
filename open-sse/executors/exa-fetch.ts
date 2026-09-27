/** Exa's content endpoint is distinct from its web-search endpoint. */
import { z } from "zod";

import { buildErrorBody } from "../utils/error.ts";
import type { WebFetchCredentials, WebFetchFormat, WebFetchResult } from "../handlers/webFetch.ts";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CHARACTERS = 100_000;
const ExaContentsSchema = z.object({
  results: z
    .array(
      z.object({
        text: z.string(),
        title: z.string().nullable().optional(),
      })
    )
    .min(1),
});

function failure(status: number, message: string): WebFetchResult {
  const body = buildErrorBody(status, message);
  return { success: false, status, error: body.error.message };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Exa response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("Exa response exceeded limit");
        throw new Error("Exa response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function exaFetch({
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
  if (!credentials.apiKey) return failure(401, "Exa API key required");
  if (format !== "markdown") return failure(400, "Exa fetch supports only markdown text");
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return failure(400, "Exa fetch requires an HTTP or HTTPS URL");
    }
  } catch {
    return failure(400, "Exa fetch requires a valid URL");
  }

  try {
    const response = await fetch(EXA_CONTENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": credentials.apiKey,
      },
      body: JSON.stringify({ ids: [url], text: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return failure(response.status, `Exa fetch returned HTTP ${response.status}`);
    }
    const parsed = ExaContentsSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return failure(502, "Exa fetch returned an invalid result");
    const first = parsed.data.results[0];
    return {
      success: true,
      data: {
        provider: "exa-search",
        url,
        content: first.text.slice(0, MAX_CHARACTERS),
        links: [],
        metadata: includeMetadata ? { title: first.title || null, description: null } : null,
        screenshot_url: null,
      },
    };
  } catch (error) {
    return failure(
      error instanceof Error && error.name === "TimeoutError" ? 504 : 502,
      "Exa fetch failed"
    );
  }
}
