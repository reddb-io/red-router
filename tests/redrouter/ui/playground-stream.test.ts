import { describe, expect, it, vi } from "vitest";
import { readChatStream } from "../../../rust-dashboard/Playground";

function stream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

describe("playground chat stream", () => {
  it("reassembles fragmented SSE frames and reports incremental content", async () => {
    const onText = vi.fn();
    const response = stream([
      ': keepalive\r\n\r\nda', 'ta: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n', 'data: [DONE]\n\n',
    ]);
    await expect(readChatStream(response, onText)).resolves.toBe("Hello!");
    expect(onText.mock.calls).toEqual([["Hello"], ["Hello!"]]);
  });

  it("rejects interrupted streams rather than treating a partial response as complete", async () => {
    const response = stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);
    await expect(readChatStream(response, vi.fn())).rejects.toThrow("ended unexpectedly");
  });

  it("surfaces upstream errors", async () => {
    const response = stream(['data: {"error":{"message":"Provider unavailable"}}\n\n']);
    await expect(readChatStream(response, vi.fn())).rejects.toThrow("Provider unavailable");
  });
});
