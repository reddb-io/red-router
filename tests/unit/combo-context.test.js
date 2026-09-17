import { describe, it, expect } from "vitest";
import {
  estimateRequestTokens,
  filterModelsByContext,
  contextOverflowResponse,
  handleComboChat,
} from "../../open-sse/services/combo.js";

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

describe("estimateRequestTokens", () => {
  it("empty body -> 0", () => {
    expect(estimateRequestTokens({})).toBe(0);
    expect(estimateRequestTokens(null)).toBe(0);
  });

  it("text at 4 chars per token", () => {
    const tokens = estimateRequestTokens({ messages: [{ role: "user", content: "a".repeat(400) }] });
    expect(tokens).toBe(100);
  });

  it("image block costs a fixed allowance, not its base64 length", () => {
    const tokens = estimateRequestTokens({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"x".repeat(500000)}` } }] }],
    });
    expect(tokens).toBe(1500);
  });

  it("counts system, tool arguments and tool schemas", () => {
    // system 400 + user 400 + arguments (stringify adds quotes: 402) + tools (stringify: 444)
    const toolsJSON = JSON.stringify([{ function: { name: "t", description: "d".repeat(400) } }]).length;
    const argsJSON = JSON.stringify("x".repeat(400)).length;
    const tokens = estimateRequestTokens({
      system: "s".repeat(400),
      messages: [{ role: "user", content: "u".repeat(400), tool_calls: [{ function: { arguments: "x".repeat(400) } }] }],
      tools: [{ function: { name: "t", description: "d".repeat(400) } }],
    });
    // 100 system + 100 user + args (402 chars) + tools (444 chars), all /4
    expect(tokens).toBe(100 + 100 + Math.ceil(argsJSON / 4) + Math.ceil(toolsJSON / 4));
  });

  it("gemini contents count", () => {
    const tokens = estimateRequestTokens({
      contents: [{ role: "user", parts: [{ text: "g".repeat(400) }] }],
    });
    expect(tokens).toBe(100);
  });
});

describe("filterModelsByContext", () => {
  it("small request keeps every member", () => {
    const filter = filterModelsByContext(["glm/glm-4.5v", "kimi/kimi-k3"], { messages: [{ role: "user", content: "hi" }] });
    expect(filter.models).toEqual(["glm/glm-4.5v", "kimi/kimi-k3"]);
    expect(filter.skipped).toEqual([]);
  });

  it("skips members whose window is smaller than the request, keeping order", () => {
    // 400k chars of text ≈ 100k tokens + 65k max_tokens = 165k needed.
    const body = { messages: [{ role: "user", content: "a".repeat(400000) }], max_tokens: 65000 };
    const filter = filterModelsByContext(["glm/glm-4.5v", "kimi/kimi-k3", "glm/glm-4.6v"], body);
    // glm-4.5v = 64k, glm-4.6v = 128k, kimi-k3 = 1,048,576
    expect(filter.models).toEqual(["kimi/kimi-k3"]);
    expect(filter.skipped).toEqual([
      { model: "glm/glm-4.5v", context: 64000 },
      { model: "glm/glm-4.6v", context: 128000 },
    ]);
  });

  it("accounts the requested output budget", () => {
    // 65k tokens of text alone fits 128k, but 65k text + 65k output does not.
    const body = { messages: [{ role: "user", content: "a".repeat(4 * 65000) }], max_tokens: 65000 };
    const filter = filterModelsByContext(["glm/glm-4.6v"], body);
    expect(filter.models).toEqual([]);
    expect(filter.skipped).toHaveLength(1);
  });
});

describe("handleComboChat context awareness", () => {
  it("skips a member that cannot hold the request without calling it", async () => {
    const body = { messages: [{ role: "user", content: "a".repeat(400000) }], max_tokens: 65000 };
    const called = [];
    const result = await handleComboChat({
      body,
      models: ["glm/glm-4.5v", "kimi/kimi-k3"],
      handleSingleModel: async (b, m) => {
        called.push(m);
        return new Response("{}", { status: 200 });
      },
      log: quietLog,
      comboName: "too-small-first",
      comboStrategy: "fallback",
    });
    expect(called).toEqual(["kimi/kimi-k3"]);
    expect(result.status).toBe(200);
  });

  it("returns a clear error naming every member when none can hold the request", async () => {
    const body = { messages: [{ role: "user", content: "a".repeat(4 * 1100000) }] };
    const called = [];
    const result = await handleComboChat({
      body,
      models: ["glm/glm-4.5v", "kimi/kimi-k3"],
      handleSingleModel: async (b, m) => {
        called.push(m);
        return new Response("{}", { status: 200 });
      },
      log: quietLog,
      comboName: "all-too-small",
      comboStrategy: "fallback",
    });
    expect(called).toEqual([]);
    expect(result.status).toBe(400);
    const payload = await result.json();
    expect(payload.error.message).toContain('Combo "all-too-small" cannot hold this request');
    expect(payload.error.message).toContain("glm/glm-4.5v (64000)");
    expect(payload.error.message).toContain("kimi/kimi-k3 (1048576)");
  });

  it("keeps the plain fallback path for requests every member can hold", async () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const called = [];
    const result = await handleComboChat({
      body,
      models: ["glm/glm-4.5v", "kimi/kimi-k3"],
      handleSingleModel: async (b, m) => {
        called.push(m);
        return new Response("{}", { status: 200 });
      },
      log: quietLog,
      comboName: "small-request",
      comboStrategy: "fallback",
    });
    expect(called).toEqual(["glm/glm-4.5v"]);
    expect(result.status).toBe(200);
  });
});

describe("contextOverflowResponse", () => {
  it("carries the estimate and each member's window", () => {
    const response = contextOverflowResponse("combo", {
      skipped: [{ model: "glm/glm-4.5v", context: 64000 }],
      needed: 90000,
    });
    return response.json().then((payload) => {
      expect(payload.error.message).toContain("~90000 tokens");
      expect(payload.error.message).toContain("glm/glm-4.5v (64000)");
    });
  });
});
