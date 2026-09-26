/** Windsurf LanguageServerService wire format (distinct from Devin Desktop). */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type WindsurfWireMessage = {
  role: string;
  content: string;
  toolCallId?: string;
};

export type WindsurfFrame =
  | { kind: "content"; text: string }
  | { kind: "done"; promptTokens: number; completionTokens: number }
  | { kind: "error"; message: string }
  | { kind: "trailer"; status: number; message: string }
  | { kind: "unsupported_tool_call" };

function varint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid Windsurf varint");
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value ? next | 128 : next);
  } while (value);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function field(number: number, value: Uint8Array): Uint8Array {
  return concat([varint((number << 3) | 2), varint(value.length), value]);
}

function stringField(number: number, value: string): Uint8Array {
  return field(number, encoder.encode(value));
}

export function encodeWindsurfChatRequest(input: {
  apiKey: string;
  modelUid: string;
  messages: WindsurfWireMessage[];
  sessionId: string;
  cascadeId: string;
  ideVersion: string;
}): Uint8Array {
  const metadata = concat([
    stringField(1, input.apiKey),
    stringField(2, "windsurf"),
    stringField(3, input.ideVersion),
    stringField(4, input.ideVersion),
    stringField(5, input.sessionId),
    stringField(6, "en-US"),
  ]);
  const messages = input.messages.map((message) =>
    field(
      4,
      concat([
        stringField(1, message.role),
        stringField(2, message.content),
        ...(message.toolCallId ? [stringField(3, message.toolCallId)] : []),
      ])
    )
  );
  return concat([
    field(1, metadata),
    stringField(2, input.cascadeId),
    field(3, stringField(1, input.modelUid)),
    ...messages,
  ]);
}

export function frameWindsurfRequest(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Windsurf request frame too large");
  const result = new Uint8Array(payload.length + 5);
  new DataView(result.buffer).setUint32(1, payload.length, false);
  result.set(payload, 5);
  return result;
}

type ProtoField = { number: number; value: Uint8Array | number };

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let factor = 1;
  for (let offset = start; offset < bytes.length && offset < start + 8; offset++) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * factor;
    if (!Number.isSafeInteger(value)) break;
    if ((byte & 0x80) === 0) return [value, offset + 1];
    factor *= 128;
  }
  throw new Error("invalid Windsurf protobuf varint");
}

function parseFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, next] = readVarint(bytes, offset);
    offset = next;
    const number = Math.floor(tag / 8);
    const type = tag % 8;
    if (number === 0) throw new Error("invalid Windsurf protobuf field");
    if (type === 0) {
      const [value, end] = readVarint(bytes, offset);
      fields.push({ number, value });
      offset = end;
    } else if (type === 2) {
      const [length, end] = readVarint(bytes, offset);
      offset = end;
      if (length > MAX_FRAME_BYTES || offset + length > bytes.length) {
        throw new Error("invalid Windsurf protobuf length");
      }
      fields.push({ number, value: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (type === 1 || type === 5) {
      const length = type === 1 ? 8 : 4;
      if (offset + length > bytes.length) throw new Error("truncated Windsurf protobuf field");
      offset += length;
    } else {
      throw new Error("unsupported Windsurf protobuf wire type");
    }
  }
  return fields;
}

function nested(bytes: Uint8Array, outer: number, inner: number): Uint8Array | undefined {
  const value = parseFields(bytes).find((item) => item.number === outer)?.value;
  if (!(value instanceof Uint8Array)) return undefined;
  const result = parseFields(value).find((item) => item.number === inner)?.value;
  return result instanceof Uint8Array ? result : undefined;
}

export function decodeWindsurfChunk(payload: Uint8Array): WindsurfFrame | null {
  for (const item of parseFields(payload)) {
    if (!(item.value instanceof Uint8Array)) continue;
    if (item.number === 1) {
      const text = nested(payload, 1, 1);
      if (text) return { kind: "content", text: decoder.decode(text) };
    }
    if (item.number === 2) return { kind: "unsupported_tool_call" };
    if (item.number === 3) {
      const usage = nested(payload, 3, 1);
      const fields = usage ? parseFields(usage) : [];
      const promptTokens = fields.find((field) => field.number === 1)?.value;
      const completionTokens = fields.find((field) => field.number === 2)?.value;
      return {
        kind: "done",
        promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
        completionTokens: typeof completionTokens === "number" ? completionTokens : 0,
      };
    }
    if (item.number === 4) {
      const message = nested(payload, 4, 1);
      return { kind: "error", message: message ? decoder.decode(message) : "Windsurf error" };
    }
  }
  return null;
}

/** Incremental parser; the caller must treat a non-zero trailer or missing trailer as failure. */
export class WindsurfFrameDecoder {
  private readonly header = new Uint8Array(5);
  private headerBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;

  constructor(private readonly maxFrameBytes = MAX_FRAME_BYTES) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 1 ||
      maxFrameBytes > MAX_FRAME_BYTES
    ) {
      throw new Error("invalid Windsurf frame limit");
    }
  }

  push(chunk: Uint8Array): WindsurfFrame[] {
    const frames: WindsurfFrame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.headerBytes < 5) {
        const count = Math.min(5 - this.headerBytes, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 5) break;
        const length = new DataView(this.header.buffer).getUint32(1, false);
        if (length > this.maxFrameBytes) throw new Error("Windsurf frame too large");
        this.payload = new Uint8Array(length);
      }
      const payload = this.payload;
      if (!payload) throw new Error("invalid Windsurf frame state");
      const count = Math.min(payload.length - this.payloadBytes, chunk.length - offset);
      payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes < payload.length) break;
      const flag = this.header[0];
      if (flag === 0) {
        const frame = decodeWindsurfChunk(payload);
        if (frame) frames.push(frame);
      } else if (flag === 0x80) {
        const trailer = decoder.decode(payload);
        const status = /^grpc-status:\s*(\d+)\s*$/im.exec(trailer);
        const message = /^grpc-message:\s*(.*)$/im.exec(trailer);
        frames.push({
          kind: "trailer",
          status: status ? Number(status[1]) : 2,
          message: message?.[1] ?? "",
        });
      } else {
        throw new Error("unsupported Windsurf frame flag");
      }
      this.headerBytes = 0;
      this.payload = null;
      this.payloadBytes = 0;
    }
    return frames;
  }

  finish(): void {
    if (this.headerBytes !== 0) throw new Error("truncated Windsurf frame");
  }
}
