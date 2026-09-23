// Contract with redcode (reddb-io/redcode, packages/core/src/provider/router.ts),
// which detects RedRouter through /v1/capabilities and sends cooperation headers.
// Header values and field names here are the ones redcode's runner sends and reads;
// a change that breaks them breaks a shipped client.
import { describe, it, expect } from "vitest";
import { decisionOptOut, parseClassificationHint, hintDeliberation } from "../../open-sse/decision/clientHint.js";
import { DECISION_HEADER, HINT_HEADER, TOKEN_SAVER_HEADER, SERVED_MODEL_HEADER, COST_HEADER } from "../../open-sse/config/runtimeConfig.js";

// What redcode's runner sends on a turn where its System One chose a skill or MCP tool.
const REDCODE_TURN = {
  "x-red-router-decision": "off",
  "x-red-router-hint": "complexity=0.72;deliberation=0.8;needs_tool=true;tier=complex",
  "x-session-affinity": "ses_abc",
  "x-session-id": "ses_abc",
};

describe("redcode cooperation headers", () => {
  it("uses the header names redcode hard-codes", () => {
    expect(DECISION_HEADER).toBe("x-red-router-decision");
    expect(HINT_HEADER).toBe("x-red-router-hint");
    expect(TOKEN_SAVER_HEADER.toLowerCase()).toBe("x-red-router-token-saver");
    expect(SERVED_MODEL_HEADER.toLowerCase()).toBe("x-redrouter-served-model");
    expect(COST_HEADER.toLowerCase()).toBe("x-redrouter-cost-usd");
  });

  it("parses the hint redcode builds", () => {
    const hint = parseClassificationHint(REDCODE_TURN["x-red-router-hint"]);
    expect(hint).toEqual({ complexity: 0.72, deliberation: 0.8, needsTool: true, tier: "COMPLEX" });
  });

  it("keeps the hinted model decision when redcode also turns decisions off", () => {
    const hint = parseClassificationHint(REDCODE_TURN["x-red-router-hint"]);
    expect(hintDeliberation(hint)).toBe(0.8);
    expect(decisionOptOut(REDCODE_TURN["x-red-router-decision"], hint)).toEqual({ tools: true, model: false });
  });

  it("turns everything off without a hint, and nothing without the header", () => {
    expect(decisionOptOut("off", null)).toEqual({ tools: true, model: true });
    expect(decisionOptOut(" OFF ", parseClassificationHint("tier=simple"))).toEqual({ tools: true, model: true });
    expect(decisionOptOut(undefined, null)).toEqual({ tools: false, model: false });
  });
});
