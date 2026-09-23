// Contract with redcode (reddb-io/redcode, packages/core/src/provider/router.ts),
// which detects RedRouter through /v1/capabilities and sends cooperation headers.
// Header values and field names here are the ones redcode's runner sends and reads;
// a change that breaks them breaks a shipped client.
import { describe, it, expect } from "vitest";
import { decisionOptOut, parseClassificationHint, hintDeliberation } from "../../open-sse/decision/clientHint.js";
import { DECISION_HEADER, HINT_HEADER, TOKEN_SAVER_HEADER, SERVED_MODEL_HEADER, COST_HEADER, CATALOG_VERSION_HEADER } from "../../open-sse/config/runtimeConfig.js";

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
    expect(CATALOG_VERSION_HEADER.toLowerCase()).toBe("x-redrouter-catalog-version");
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

// Access-control answers a client can act on: 403 means "pick another model"
// (and refresh the catalog), 429 means "wait Retry-After". The reason header
// tells them apart from an upstream failure.
describe("access-control errors", () => {
  it("answer with a stable status, reason header and Retry-After", async () => {
    const { responseFromRoutingCandidate } = await import("../../open-sse/utils/error.js");
    const cases = [
      [{ reason: "model_disabled", status: 403, message: "Model x is disabled", retryable: false }, 403],
      [{ reason: "model_not_allowed", status: 403, message: "This API key may not use model x", retryable: false }, 403],
      [{ reason: "api_key_limit", status: 429, message: "API key rate limit reached", retryable: true, retryAtMs: Date.now() + 30_000 }, 429],
    ];
    for (const [candidate, status] of cases) {
      const res = responseFromRoutingCandidate(candidate, { errorFormat: "openai" });
      expect(res.status).toBe(status);
      expect(res.headers.get("X-9Router-Reason")).toBe(candidate.reason);
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-9Router-Reason");
      if (status === 429) expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
  });
});
