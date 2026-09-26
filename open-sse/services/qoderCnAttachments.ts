import { createHash, randomUUID } from "node:crypto";

import { buildQoderCnCosyHeaders, type QoderCnCosyCredential } from "./qoderCnCosy.ts";

const UPLOAD_BASE = "https://gateway.qoder.com.cn/algo/api/v2/image/upload";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024;
const IMAGE_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
]);
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

export class QoderCnAttachmentInputError extends Error {}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) {
    throw new Error("Qoder CN image URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Qoder CN image URL is invalid");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Qoder CN image URL is invalid");
  }
  return value;
}

function decodeImageDataUri(value: string): { bytes: Uint8Array; mediaType: string; ext: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new QoderCnAttachmentInputError("Qoder CN image data URI is invalid");
  const mediaType = match[1].toLowerCase();
  const ext = IMAGE_MIME.get(mediaType);
  if (!ext) throw new QoderCnAttachmentInputError("Qoder CN image type is unsupported");
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw new QoderCnAttachmentInputError("Qoder CN image exceeds the upload limit");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new QoderCnAttachmentInputError("Qoder CN image exceeds the upload limit");
  }
  if (bytes.toString("base64") !== match[2]) {
    throw new QoderCnAttachmentInputError("Qoder CN image base64 is invalid");
  }
  return { bytes, mediaType, ext };
}

async function readUploadResult(response: Response): Promise<string> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Qoder CN image upload returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder CN image upload returned an empty body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_UPLOAD_RESPONSE_BYTES) {
        await reader.cancel("Qoder CN image upload response exceeded limit");
        throw new Error("Qoder CN image upload response exceeded limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("Qoder CN image upload returned invalid JSON");
  }
  const outer = record(value);
  let result = record(outer?.result) || outer;
  if (typeof outer?.body === "string") {
    try {
      result = record(JSON.parse(outer.body)) || result;
    } catch {
      // Other response fields may still contain the uploaded URL.
    }
  }
  const candidates = [
    result?.imageUrls,
    result?.image_urls,
    result?.imageUrl,
    result?.image_url,
    result?.url,
    result?.ossUrl,
    result?.oss_url,
    outer?.imageUrls,
    outer?.image_urls,
    outer?.imageUrl,
    outer?.image_url,
    outer?.url,
  ];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value === "string") return httpsUrl(value);
  }
  throw new Error("Qoder CN image upload omitted its URL");
}

async function uploadImage(
  dataUri: string,
  credentials: QoderCnCosyCredential,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<string> {
  const { bytes, mediaType, ext } = decodeImageDataUri(dataUri);
  const boundary = `----OmniRouteQoder${randomUUID().replace(/-/g, "")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${ext}"\r\nContent-Type: ${mediaType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);
  const url = `${UPLOAD_BASE}?request_id=${randomUUID()}`;
  const headers = {
    ...buildQoderCnCosyHeaders(body, url, credentials),
    Accept: "application/json",
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(body.byteLength),
    "Accept-Encoding": "identity",
    "AI-CLIENT-TIMESTAMP": String(Math.floor(Date.now() / 1000)),
  };
  // A stream marks this signed PUT as non-replayable in the shared proxy fetcher.
  const signedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetchImpl(url, {
    method: "PUT",
    headers,
    body: signedBody,
    duplex: "half",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  } as RequestInit & { duplex: "half" });
  return readUploadResult(response);
}

/** Upload inline images once per request; reject unported document formats explicitly. */
export async function rewriteQoderCnAttachments(
  rawBody: unknown,
  credentials: QoderCnCosyCredential,
  fetchImpl: FetchLike,
  signal?: AbortSignal
): Promise<unknown> {
  const body = record(rawBody);
  if (!body || !Array.isArray(body.messages)) return rawBody;
  const uploaded = new Map<string, string>();
  const messages: unknown[] = [];
  for (const rawMessage of body.messages) {
    const message = record(rawMessage);
    if (!message || !Array.isArray(message.content)) {
      messages.push(rawMessage);
      continue;
    }
    const content: unknown[] = [];
    for (const rawPart of message.content) {
      const part = record(rawPart);
      if (!part) throw new QoderCnAttachmentInputError("Qoder CN attachment part is invalid");
      if (part.type === "text") {
        content.push(rawPart);
        continue;
      }
      let source: string | null = null;
      if (part.type === "image_url") {
        const image = record(part.image_url);
        source =
          typeof part.image_url === "string"
            ? part.image_url
            : typeof image?.url === "string"
              ? image.url
              : null;
      } else if (part.type === "image") {
        const image = record(part.source);
        if (image?.type === "base64" && typeof image.data === "string") {
          source = `data:${typeof image.media_type === "string" ? image.media_type : "image/png"};base64,${image.data}`;
        } else if (image?.type === "url" && typeof image.url === "string") {
          source = image.url;
        }
      }
      if (!source) throw new QoderCnAttachmentInputError("Qoder CN attachment type is unsupported");
      let url: string;
      if (source.startsWith("data:")) {
        const key = createHash("sha256").update(source).digest("hex");
        url = uploaded.get(key) || (await uploadImage(source, credentials, fetchImpl, signal));
        uploaded.set(key, url);
      } else {
        try {
          url = httpsUrl(source);
        } catch {
          throw new QoderCnAttachmentInputError("Qoder CN image URL is invalid");
        }
      }
      content.push({ type: "image_url", image_url: { url } });
    }
    messages.push({ ...message, content });
  }
  return { ...body, messages };
}
