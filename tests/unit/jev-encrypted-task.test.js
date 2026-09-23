// Delegated agent tasks with encrypted content (Codex subagents) give the decision
// model nothing readable, so no decision call is made for them.
import { describe, it, expect } from "vitest";
import { extractSignals, isEncryptedTask } from "../../open-sse/decision/signals.js";
import { decideComboModel, decideTool, planReasoning } from "../../src/sse/services/decisionRouter.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

const encryptedBody = {
  model: "auto",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "earlier ask" }] },
    {
      type: "agent_message",
      content: [
        { type: "input_text", text: "Delegated task:" },
        { type: "encrypted_content", encrypted_content: "gAAAAB…ciphertext" },
      ],
    },
  ],
  tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
};

const plainBody = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the build" }] }] };

// A target whose fetch fails the test if the decision model is ever asked.
const neverAsked = { url: "http://jev.invalid", fetchImpl: async () => { throw new Error("decision model must not be asked"); } };

describe("encrypted delegated tasks", () => {
  it("is detected from the newest agent_message, ignoring later tool traffic", () => {
    expect(isEncryptedTask(encryptedBody)).toBe(true);
    expect(isEncryptedTask({
      ...encryptedBody,
      input: [...encryptedBody.input, { type: "function_call", call_id: "c", name: "shell", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "ok" }],
    })).toBe(true);
    expect(isEncryptedTask(plainBody)).toBe(false);
    expect(isEncryptedTask({ input: [{ type: "agent_message", content: [{ type: "input_text", text: "clear task" }] }] })).toBe(false);
    expect(extractSignals(encryptedBody).encryptedTask).toBe(true);
  });

  it("skips the model decision", async () => {
    const result = await decideComboModel({
      body: encryptedBody,
      models: ["cheap/m", "pricey/m"],
      ranked: ["cheap/m", "pricey/m"],
      comboName: "auto",
      config: { model: "jev-latest", timeoutMs: 100 },
      target: neverAsked,
      signals: extractSignals(encryptedBody),
    });
    expect(result).toMatchObject({ models: ["cheap/m", "pricey/m"], decision: null, reason: "encrypted_task" });
  });

  it("skips the tool decision", async () => {
    const result = await decideTool({
      body: encryptedBody,
      tools: [{ name: "shell", description: "run a command" }, { name: "read", description: "read a file" }],
      config: { model: "jev-latest", timeoutMs: 100 },
      target: neverAsked,
    });
    expect(result).toBeNull();
  });

  it("sets reasoning from deterministic signals without asking the decision model", async () => {
    const plan = await planReasoning({
      body: encryptedBody,
      settings: { reasoningAutopilot: { mode: "enforce", all: true, askJevDirect: true, floor: "minimal", ceiling: "xhigh" } },
      sessionId: "enc-1",
    });
    expect(plan).toMatchObject({ deliberation: null, cause: "default", target: { mode: "set", level: "medium" } });
  });
});

describe("JEV pricing", () => {
  it("prices the OpenRouter and OpenCode Zen ids", () => {
    expect(getPricingForModel("openrouter", "typesafe/jev-1.13")).toMatchObject({ input: 0.042, output: 0 });
    expect(getPricingForModel("opencode-zen", "jev-1.13-free")).toMatchObject({ input: 0, output: 0 });
  });
});
