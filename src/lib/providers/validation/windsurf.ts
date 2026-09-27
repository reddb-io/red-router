import { WindsurfExecutor } from "@omniroute/open-sse/executors/windsurf.ts";

const PROBE_MODEL = "gpt-4.1-mini";
const MAX_PROBE_BYTES = 64 * 1024;

/** The provider has no authenticated /models endpoint; validate through its chat wire. */
export async function validateWindsurfProvider({ apiKey }: { apiKey: string }) {
  if (!apiKey?.trim()) return { valid: false, error: "Windsurf API key is required" };
  const signal = AbortSignal.timeout(20_000);
  const result = await new WindsurfExecutor().execute({
    model: PROBE_MODEL,
    body: { messages: [{ role: "user", content: "Reply OK." }] },
    stream: true,
    credentials: { apiKey: apiKey.trim() },
    signal,
  });
  if (!result.response.ok) {
    void result.response.body?.cancel().catch(() => {});
    return {
      valid: false,
      statusCode: result.response.status,
      error: `Windsurf probe returned HTTP ${result.response.status}`,
    };
  }
  const reader = result.response.body?.getReader();
  if (!reader) return { valid: false, error: "Windsurf probe returned no stream" };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_PROBE_BYTES) {
        await reader.cancel("Windsurf validation output exceeded limit");
        return { valid: false, error: "Windsurf probe output exceeded limit" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { valid: false, error: "Windsurf validation stream failed" };
  } finally {
    reader.releaseLock();
  }
  let finished = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (chunk.error) return { valid: false, error: "Windsurf rejected the probe" };
      if (Array.isArray(chunk.choices)) {
        const choice = chunk.choices[0] as { finish_reason?: unknown } | undefined;
        if (choice?.finish_reason === "stop") finished = true;
      }
    } catch {
      return { valid: false, error: "Windsurf probe returned invalid SSE" };
    }
  }
  return finished
    ? { valid: true, error: null }
    : { valid: false, error: "Windsurf probe ended without completion" };
}
