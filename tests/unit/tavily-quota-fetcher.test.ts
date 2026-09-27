import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTavilyToken,
  getTavilyBaseUrl,
  parseTavilyCreditUsage,
} from "../../open-sse/services/tavilyQuotaFetcher.ts";

test("Tavily quota prefers a key-specific credit limit", () => {
  const quota = parseTavilyCreditUsage({
    key: { limit: 50, usage: 5 },
    account: { current_plan: "Researcher", plan_limit: 1000, plan_usage: 200 },
  });

  assert.equal(quota?.total, 50);
  assert.equal(quota?.used, 5);
  assert.equal(quota?.remainingCredits, 45);
  assert.equal(quota?.planName, "Researcher");
  assert.equal(quota?.limitReached, false);
});

test("Tavily quota accounts for pay-as-you-go credits", () => {
  const quota = parseTavilyCreditUsage({
    account: { plan_limit: 100, plan_usage: 100, paygo_limit: 20, paygo_usage: 5 },
  });

  assert.equal(quota?.total, 120);
  assert.equal(quota?.used, 105);
  assert.equal(quota?.remainingCredits, 15);
  assert.equal(quota?.limitReached, false);
});

test("Tavily quota rejects malformed usage instead of inventing a limit", () => {
  assert.equal(parseTavilyCreditUsage({ account: { plan_usage: 10 } }), null);
  assert.equal(parseTavilyCreditUsage(null), null);
});

test("Tavily token resolution prefers the connection key", () => {
  assert.equal(
    extractTavilyToken({ apiKey: " first ", credentials: { apiKey: "second" } }),
    "first"
  );
  assert.equal(extractTavilyToken({ credentials: { apiKey: " second " } }), "second");
  assert.equal(extractTavilyToken({ credentials: {} }), null);
});

test("Tavily recognizes a custom self-hosted base URL", () => {
  assert.equal(getTavilyBaseUrl({ baseUrl: "https://tavily.local/" }), "https://tavily.local");
});
