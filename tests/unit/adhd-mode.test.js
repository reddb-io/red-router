import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { injectAdhd } from "../../open-sse/rtk/adhd.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { ADHD_LEVELS, ADHD_PROMPTS } from "../../open-sse/rtk/adhdPrompt.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../../open-sse/translator/schema/blocks.js";
import { ROLE } from "../../open-sse/translator/schema/roles.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import { ADHD_LEVELS as DASHBOARD_ADHD_LEVELS } from "../../src/app/(dashboard)/dashboard/endpoint/endpointConstants.js";

vi.mock("@/lib/localDb", () => ({ getApiKeyOwner: async () => null }));
const { TOKEN_SAVER_KEYS, resolveTokenSaverFor } = await import("@/lib/auth/scopedSettings");

const SEP = "\n\n";
const FULL = ADHD_PROMPTS[ADHD_LEVELS.FULL];
const LITE = ADHD_PROMPTS[ADHD_LEVELS.LITE];

describe("ADHD prompts", () => {
  it("has a non-empty prompt for every level, and only lite/full", () => {
    expect(Object.values(ADHD_LEVELS).sort()).toEqual(["full", "lite"]);
    for (const level of Object.values(ADHD_LEVELS)) {
      expect(typeof ADHD_PROMPTS[level]).toBe("string");
      expect(ADHD_PROMPTS[level].length).toBeGreaterThan(0);
    }
  });

  it("every level leads with the action, numbers steps and ends with one next action", () => {
    for (const prompt of [LITE, FULL]) {
      expect(prompt).toContain("Lead with the next action");
      expect(prompt).toContain("Number multi-step work");
      expect(prompt).toContain("fewest steps");
      expect(prompt).toContain("under two minutes");
      expect(prompt).toContain("No preamble, no recap, no closing pleasantries");
    }
  });

  it("every level persists until the reader turns it off", () => {
    for (const prompt of [LITE, FULL]) {
      expect(prompt).toContain("ACTIVE EVERY RESPONSE");
      expect(prompt).toContain("stop adhd mode");
      expect(prompt).toContain("normal mode");
    }
  });

  it("full carries the rules lite leaves out", () => {
    for (const rule of ["Suppress tangents", "Restate state every turn", "Step 3 of 5 done", "specific time estimates", "Make completed work visible", "Matter-of-fact tone", "five items", "Break these rules when", "Before sending, delete"]) {
      expect(FULL).toContain(rule);
      expect(LITE).not.toContain(rule);
    }
  });

  it("keeps the MIT attribution for the upstream skill", () => {
    const src = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../open-sse/rtk/adhdPrompt.js"), "utf8");
    expect(src).toContain("Adapted from i-have-adhd skill (https://github.com/ayghri/i-have-adhd)");
    expect(src).toContain("Copyright (c) 2026 Ayoub Ghriss");
    expect(src).toContain("The above copyright notice and this permission notice shall be included");
  });

  it("dashboard levels match the engine levels", () => {
    expect(DASHBOARD_ADHD_LEVELS.map((l) => l.id).sort()).toEqual(Object.values(ADHD_LEVELS).sort());
  });
});

describe("injectAdhd per wire format", () => {
  it("chat: appends to the existing system message", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }, { role: ROLE.USER, content: "hi" }] };
    injectAdhd(body, FORMATS.OPENAI, "full");
    expect(body.messages[0].content).toBe(`base${SEP}${FULL}`);
  });

  it("chat: creates a system message when none exists", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    injectAdhd(body, FORMATS.OPENAI, "lite");
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: LITE });
  });

  it("chat array content: appends an OpenAI text block", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: [{ type: OPENAI_BLOCK.TEXT, text: "base" }] }] };
    injectAdhd(body, FORMATS.OPENAI, "full");
    expect(body.messages[0].content.at(-1)).toEqual({ type: OPENAI_BLOCK.TEXT, text: FULL });
  });

  it("responses: instructions string", () => {
    const body = { instructions: "base", input: [] };
    injectAdhd(body, FORMATS.OPENAI_RESPONSES, "full");
    expect(body.instructions).toBe(`base${SEP}${FULL}`);
  });

  it("responses: input[] gets a typed system message", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" }] }] };
    injectAdhd(body, FORMATS.OPENAI_RESPONSES, "full");
    expect(body.input[0]).toEqual({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: FULL }] });
  });

  it("claude: system field, never a system role turn", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "base", cache_control: { type: "ephemeral" } }], messages: [{ role: ROLE.USER, content: "hi" }] };
    injectAdhd(body, FORMATS.CLAUDE, "full");
    expect(body.system[0]).toEqual({ type: CLAUDE_BLOCK.TEXT, text: FULL });
    expect(body.messages.some((m) => m.role === ROLE.SYSTEM)).toBe(false);
  });

  it("gemini: systemInstruction parts", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    injectAdhd(body, FORMATS.GEMINI, "full");
    expect(body.systemInstruction).toEqual({ parts: [{ text: FULL }] });
  });

  it("kiro: prefixes the first user turn", () => {
    const body = { conversationState: { history: [], currentMessage: { userInputMessage: { content: "tail", modelId: "m" } } } };
    injectAdhd(body, FORMATS.KIRO, "lite");
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(`${LITE}${SEP}tail`);
  });

  it("is idempotent on retry", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }] };
    injectAdhd(body, FORMATS.OPENAI, "full");
    injectAdhd(body, FORMATS.OPENAI, "full");
    expect(body.messages[0].content).toBe(`base${SEP}${FULL}`);
  });

  it("unknown level and frozen bodies fail open", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }] };
    injectAdhd(body, FORMATS.OPENAI, "ultra");
    expect(body.messages[0].content).toBe("base");
    Object.freeze(body);
    Object.freeze(body.messages);
    expect(() => injectAdhd(body, FORMATS.OPENAI, "full")).not.toThrow();
  });

  it("composes after caveman and ponytail in a fixed order without duplicates", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }] };
    for (let i = 0; i < 2; i++) {
      injectCaveman(body, FORMATS.OPENAI, "full");
      injectPonytail(body, FORMATS.OPENAI, "full");
      injectAdhd(body, FORMATS.OPENAI, "full");
    }
    expect(body.messages[0].content).toBe(["base", CAVEMAN_PROMPTS.full, PONYTAIL_PROMPTS.full, FULL].join(SEP));
  });
});

describe("ADHD settings", () => {
  it("defaults to off at the full level", () => {
    const settings = mergeWithDefaults({});
    expect(settings.adhdEnabled).toBe(false);
    expect(settings.adhdLevel).toBe("full");
  });

  it("is a per-key token-saver override", () => {
    expect(TOKEN_SAVER_KEYS).toEqual(expect.arrayContaining(["adhdEnabled", "adhdLevel"]));
    const settings = {
      adhdEnabled: false,
      adhdLevel: "full",
      tokenSaverByOwner: { bob: { adhdEnabled: true, adhdLevel: "lite" } },
    };
    const bob = resolveTokenSaverFor(settings, "bob");
    expect(bob.effective.adhdEnabled).toBe(true);
    expect(bob.effective.adhdLevel).toBe("lite");
    expect(bob.overridden).toEqual(expect.arrayContaining(["adhdEnabled", "adhdLevel"]));
    const alice = resolveTokenSaverFor(settings, "alice");
    expect(alice.effective.adhdEnabled).toBe(false);
    expect(alice.effective.adhdLevel).toBe("full");
  });
});
