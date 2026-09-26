// Deterministic request probes the decision engine needs from the raw client body:
// a rough context-token estimate and the media capabilities the request requires.
//
// ADAPTER — the legacy fork (c66f917c) imported these from
// open-sse/services/combo.js (estimateRequestTokens / detectRequiredCapabilities).
// This base's combo engine has neither export yet, so a slim, behaviour-compatible
// port lives here instead.
//
// TODO(fork-port): replace these with the full legacy combo implementations (or
// port them into this base's combo service) if routing decisions prove sensitive
// to their precision — the slim versions below cover the shapes the decision
// engine reads (OpenAI chat, Claude, Responses, Gemini) and only vision/pdf for
// capabilities.

type JsonRecord = Record<string, unknown>;

const MEDIA_TOKEN_COSTS = { image: 1600 };
const CHARS_PER_TOKEN = 4;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

const textTokens = (text: unknown): number =>
  typeof text === "string" ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;

function contentTokens(content: unknown): number {
  if (!content) return 0;
  if (typeof content === "string") return textTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum: number, part: unknown) => {
      const p = asRecord(part);
      if (!p) return sum;
      if (typeof p.text === "string") return sum + textTokens(p.text);
      return sum + contentTokens(p.content);
    }, 0);
  }
  return textTokens(JSON.stringify(content));
}

export function estimateRequestTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const b = body as JsonRecord;
  let tokens = Array.isArray(b.system) ? contentTokens(b.system) : textTokens(b.system);
  for (const message of (b.messages as JsonRecord[]) ?? []) {
    const m = asRecord(message);
    if (!m) continue;
    tokens += contentTokens(m.content);
    if (Array.isArray(m.images)) tokens += MEDIA_TOKEN_COSTS.image * m.images.length;
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls as JsonRecord[]) {
        tokens += textTokens(JSON.stringify(asRecord(call?.function)?.arguments ?? ""));
      }
    }
  }
  for (const item of (b.input as JsonRecord[]) ?? []) {
    const it = asRecord(item);
    if (it) tokens += contentTokens(it.content);
  }
  for (const turn of (b.contents as JsonRecord[]) ?? []) {
    const t = asRecord(turn);
    if (!t) continue;
    for (const part of (t.parts as JsonRecord[]) ?? []) {
      const p = asRecord(part);
      if (!p) continue;
      tokens += textTokens(p.text);
      if (p.inlineData || p.fileData) tokens += MEDIA_TOKEN_COSTS.image;
    }
  }
  if (Array.isArray(b.tools)) tokens += Math.ceil(JSON.stringify(b.tools).length / CHARS_PER_TOKEN);
  return tokens;
}

const MEDIA_BLOCK_TYPES = new Set([
  "image_url",
  "image",
  "input_image",
  "input_file",
  "file",
  "document",
]);

function contentRequiresMedia(content: unknown, required: Set<string>): void {
  if (typeof content === "string") {
    if (content.includes("data:image/")) required.add("vision");
    else if (content.includes("data:application/pdf")) required.add("pdf");
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    const type = typeof b.type === "string" ? b.type : "";
    if (MEDIA_BLOCK_TYPES.has(type)) required.add("vision");
    if (b.inlineData || b.fileData) required.add("vision");
  }
}

/**
 * The slim capability probe: reports "vision"/"pdf" when the body's trailing user
 * turns carry media or file blocks, across the known message shapes.
 */
export function detectRequiredCapabilities(body: unknown): Set<string> {
  const required = new Set<string>();
  if (!body || typeof body !== "object") return required;
  const b = body as JsonRecord;

  const trailingUser = (items: unknown): void => {
    const arr = Array.isArray(items) ? (items as JsonRecord[]) : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = asRecord(arr[i]);
      if (!item || item.role !== "user") continue;
      contentRequiresMedia(item.content, required);
      break; // trailing user turn only
    }
  };

  trailingUser(b.messages);
  trailingUser(b.input);
  const contents = (b.contents || asRecord(b.request)?.contents) as JsonRecord[] | undefined;
  if (Array.isArray(contents)) {
    for (let i = contents.length - 1; i >= 0; i--) {
      const t = asRecord(contents[i]);
      if (!t) continue;
      contentRequiresMedia(t.parts, required);
      break; // trailing turn only
    }
  }
  return required;
}
