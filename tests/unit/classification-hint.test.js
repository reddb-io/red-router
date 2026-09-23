// x-red-router-hint: a client-side classification that replaces decision-model
// questions. Parsing is strict and fails open; routing uses what parses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import {
  parseClassificationHint,
  hintTier,
  hintDeliberation,
  hintDetail,
  HINT_KEYS,
  HINT_SOURCE,
} from "../../open-sse/decision/clientHint.js";
import { buildModelQuestions, DELIBERATION_KEY, MODEL_KEY } from "../../open-sse/decision/questions.js";
import { buildDecisionDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { HINT_HEADER } from "../../open-sse/config/runtimeConfig.js";

describe("parseClassificationHint", () => {
  it("parses every known key", () => {
    expect(parseClassificationHint("complexity=0.8;deliberation=0.25;needs_tool=true;tier=complex")).toEqual({
      complexity: 0.8,
      deliberation: 0.25,
      needsTool: true,
      tier: "COMPLEX",
    });
  });

  it("accepts complexity labels, case and whitespace variations, and one trailing separator", () => {
    expect(parseClassificationHint(" Complexity = Reasoning ; NEEDS_TOOL=False ; ")).toEqual({
      complexity: 0.875,
      needsTool: false,
    });
    expect(parseClassificationHint("deliberation=.5")).toEqual({ deliberation: 0.5 });
    expect(parseClassificationHint("deliberation=1.0")).toEqual({ deliberation: 1 });
    expect(parseClassificationHint("deliberation=0")).toEqual({ deliberation: 0 });
  });

  it("parses the reasoning keys: effort, stall, feedback and frustration", () => {
    expect(parseClassificationHint("effort=XHigh;stall=true;feedback=rejects;frustration=0.7")).toEqual({
      effort: "xhigh",
      stall: true,
      feedback: "rejects",
      frustration: 0.7,
    });
    expect(parseClassificationHint("effort=none;stall=false;feedback=neutral;frustration=0")).toEqual({
      effort: "none",
      stall: false,
      feedback: "neutral",
      frustration: 0,
    });
  });

  it("skips unknown keys but keeps the known ones", () => {
    expect(parseClassificationHint("future_key=whatever;deliberation=0.4")).toEqual({ deliberation: 0.4 });
  });

  it("returns null without complaint when the header is absent or blank", () => {
    const onInvalid = vi.fn();
    expect(parseClassificationHint(undefined, { onInvalid })).toBeNull();
    expect(parseClassificationHint(null, { onInvalid })).toBeNull();
    expect(parseClassificationHint("   ", { onInvalid })).toBeNull();
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it.each([
    ["complexity=1.5", "invalid_value:complexity"],
    ["deliberation=-0.1", "invalid_value:deliberation"],
    ["deliberation=high", "invalid_value:deliberation"],
    ["deliberation=0.5e0", "invalid_value:deliberation"],
    ["needs_tool=yes", "invalid_value:needs_tool"],
    ["tier=huge", "invalid_value:tier"],
    ["effort=auto", "invalid_value:effort"],
    ["effort=ultra", "invalid_value:effort"],
    ["stall=1", "invalid_value:stall"],
    ["feedback=angry", "invalid_value:feedback"],
    ["frustration=2", "invalid_value:frustration"],
    ["frustration=high", "invalid_value:frustration"],
    ["complexity=0.2;complexity=0.3", "duplicate_key:complexity"],
    ["complexity", "malformed_pair:complexity"],
    ["complexity=0.2;;tier=simple", "malformed_pair:"],
    ["=0.2", "malformed_pair:=0.2"],
    ["complexity=0.2=0.3", "malformed_pair:complexity=0.2=0.3"],
    ["complexity=", "malformed_pair:complexity="],
    ["other=1", "no_known_keys"],
  ])("drops the whole hint for %j", (raw, reason) => {
    const onInvalid = vi.fn();
    expect(parseClassificationHint(raw, { onInvalid })).toBeNull();
    expect(onInvalid).toHaveBeenCalledWith(reason);
  });

  it("drops a valid pair when another pair in the same header is invalid", () => {
    expect(parseClassificationHint("deliberation=0.4;needs_tool=maybe")).toBeNull();
  });

  it("drops oversized headers and non-string values", () => {
    expect(parseClassificationHint(`deliberation=0.4;${"x=1;".repeat(200)}`)).toBeNull();
    expect(parseClassificationHint(["deliberation=0.4"])).toBeNull();
  });

  it("never throws out of a failing diagnostics callback", () => {
    expect(parseClassificationHint("tier=nope", { onInvalid: () => { throw new Error("boom"); } })).toBeNull();
  });
});

describe("hint signals", () => {
  it("maps complexity bands to smart tiers, and an explicit tier wins", () => {
    expect(hintTier({ complexity: 0 })).toBe("SIMPLE");
    expect(hintTier({ complexity: 0.24 })).toBe("SIMPLE");
    expect(hintTier({ complexity: 0.25 })).toBe("MEDIUM");
    expect(hintTier({ complexity: 0.5 })).toBe("COMPLEX");
    expect(hintTier({ complexity: 0.75 })).toBe("REASONING");
    expect(hintTier({ complexity: 1 })).toBe("REASONING");
    expect(hintTier(parseClassificationHint("complexity=medium"))).toBe("MEDIUM");
    expect(hintTier({ complexity: 0.1, tier: "COMPLEX" })).toBe("COMPLEX");
    expect(hintTier({ deliberation: 0.9 })).toBeNull();
    expect(hintTier(null)).toBeNull();
  });

  it("reads deliberation only from its own key", () => {
    expect(hintDeliberation({ deliberation: 0.3 })).toBe(0.3);
    expect(hintDeliberation({ complexity: 0.9 })).toBeNull();
    expect(hintDeliberation(null)).toBeNull();
  });

  it("records the hint and what it replaced", () => {
    const detail = hintDetail(parseClassificationHint("complexity=0.1;deliberation=0.2;needs_tool=false"), ["tier", "tier", "effort"]);
    expect(detail).toEqual({
      source: "client_hint",
      complexity: 0.1,
      deliberation: 0.2,
      needs_tool: false,
      tier: "SIMPLE",
      effort: null,
      stall: null,
      feedback: null,
      frustration: null,
      used_for: ["tier", "effort"],
    });
    expect(hintDetail(parseClassificationHint("effort=high;feedback=corrects"), ["reasoning"])).toMatchObject({
      effort: "high",
      feedback: "corrects",
      used_for: ["reasoning"],
    });
    expect(hintDetail(null)).toBeNull();
  });

  it("puts the hint in the request's decision detail", () => {
    const hint = hintDetail({ tier: "COMPLEX" }, ["tier"]);
    expect(buildDecisionDetail(null, null, hint)).toEqual({ hint });
    const detail = buildDecisionDetail({ model: "a/b", apply: true, deliberation: 0.2, deliberationSource: HINT_SOURCE }, null, hint);
    expect(detail.model.deliberation_source).toBe("client_hint");
    expect(buildDecisionDetail(null, null, null)).toBeUndefined();
  });

  it("exposes the header name and the keys capabilities advertises", () => {
    expect(HINT_HEADER).toBe("x-red-router-hint");
    expect(HINT_KEYS).toEqual(["complexity", "deliberation", "needs_tool", "tier", "effort", "stall", "feedback", "frustration"]);
  });
});

describe("model questions with a hinted deliberation", () => {
  it("still asks both questions by default", () => {
    const { questions } = buildModelQuestions(["a/x", "a/y"], () => "brief");
    expect(Object.keys(questions)).toEqual([MODEL_KEY, DELIBERATION_KEY]);
  });

  it("drops the deliberation question when the client stated it", () => {
    const { questions } = buildModelQuestions(["a/x", "a/y"], () => "brief", { deliberation: false });
    expect(Object.keys(questions)).toEqual([MODEL_KEY]);
  });
});

describe("decideComboModel with a hinted deliberation", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let decideComboModel;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-hint-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    ({ decideComboModel } = await import("../../src/sse/services/decisionRouter.js"));
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  const models = ["unpriced-a/model-one", "unpriced-b/model-two"];
  const body = { messages: [{ role: "user", content: "rename this variable" }] };
  const config = { model: "typesafe-ai/jev", timeoutMs: 1000, minStrength: 0.35, switchStrength: 0.6 };

  function targetAnswering(answers, sent) {
    return {
      url: "http://decision.test/v1/systemone",
      apiKey: "k",
      provider: "typesafe-ai",
      headers: {},
      fetchImpl: async (_url, options) => {
        sent.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ model: "jev", answers, usage: { input_tokens: 1, output_tokens: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
  }

  it("asks only the model question and answers deliberation from the hint", async () => {
    const sent = [];
    const target = targetAnswering({
      model: { type: "choice", choice: models[1], confidence: 0.95, probabilities: { [models[0]]: 0.05, [models[1]]: 0.95 } },
    }, sent);

    const result = await decideComboModel({ body, models, comboName: "c", config, target, hintedDeliberation: 0.2 });

    expect(Object.keys(sent[0].questions)).toEqual([MODEL_KEY]);
    expect(result.decision.apply).toBe(true);
    expect(result.decision.model).toBe(models[1]);
    expect(result.decision.deliberation).toBe(0.2);
    expect(result.decision.deliberationSource).toBe("client_hint");
    expect(result.models[0]).toBe(models[1]);
  });

  it("asks both questions without a hint, as before", async () => {
    const sent = [];
    const target = targetAnswering({
      model: { type: "choice", choice: models[1], confidence: 0.95, probabilities: { [models[0]]: 0.05, [models[1]]: 0.95 } },
      needs_reasoning: { type: "noul", noul: 0.6 },
    }, sent);

    const result = await decideComboModel({ body, models, comboName: "c", config, target });

    expect(Object.keys(sent[0].questions)).toEqual([MODEL_KEY, DELIBERATION_KEY]);
    expect(result.decision.deliberation).toBe(0.6);
    expect(result.decision.deliberationSource).toBeUndefined();
  });
});
