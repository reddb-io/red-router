import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GetUsableModels goes over HTTP/2 (http2.connect), so the transport is faked here:
// each request answers with `h2.reply` and is recorded in `h2.requests`.
const h2 = vi.hoisted(() => ({ reply: { status: 200, body: new Uint8Array() }, requests: [] }));
vi.mock("http2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const connect = (origin) => {
    const client = new Emitter();
    client.close = () => {};
    client.request = (headers) => {
      const req = new Emitter();
      h2.requests.push({ origin, headers });
      req.end = () => {
        queueMicrotask(() => {
          req.emit("response", { ":status": h2.reply.status });
          if (h2.reply.body.length) req.emit("data", Buffer.from(h2.reply.body));
          req.emit("end");
        });
      };
      req.write = () => {};
      req.close = () => {};
      return req;
    };
    return client;
  };
  return { default: { connect }, connect };
});
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";


function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.requests = [];
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    h2.reply = { status: 200, body: payload };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Second call served from the cache.
    expect(h2.requests).toHaveLength(1);
    expect(h2.requests[0].origin).toBe("https://agent.api5.cursor.sh");
    expect(h2.requests[0].headers).toMatchObject({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      "content-type": "application/proto",
      accept: "application/proto",
    });
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.reply = { status: 403, body: new TextEncoder().encode("no") };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
