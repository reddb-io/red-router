import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWebFetchModel,
  toNineRouterWebFetchResponse,
} from "../../src/app/api/v1/web/fetch/nineRouterCompat.ts";
import { v1WebFetchSchema } from "../../src/shared/validation/schemas/apiV1.ts";

test("9router model IDs resolve to the existing provider transports", () => {
  assert.deepEqual(resolveWebFetchModel(undefined, "firecrawl/fetch"), {
    ok: true,
    provider: "firecrawl",
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel(undefined, "exa"), {
    ok: true,
    provider: "exa-search",
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel(undefined, "fetch-combo"), {
    ok: true,
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel("firecrawl", undefined), {
    ok: true,
    provider: "firecrawl",
    legacyResponse: false,
  });
  assert.deepEqual(resolveWebFetchModel("firecrawl", undefined, "1"), {
    ok: true,
    provider: "firecrawl",
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel("exa", undefined), {
    ok: true,
    provider: "exa-search",
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel("tavily", "tavily/fetch"), {
    ok: true,
    provider: "tavily-search",
    legacyResponse: true,
  });
  assert.deepEqual(resolveWebFetchModel("firecrawl", "exa"), { ok: false });
  assert.deepEqual(resolveWebFetchModel("unknown", undefined), { ok: false });
  assert.deepEqual(resolveWebFetchModel(undefined, "missing/fetch"), { ok: false });
  assert.equal(
    v1WebFetchSchema.parse({ url: "https://example.com", model: "firecrawl/fetch" }).model,
    "firecrawl/fetch"
  );
  assert.equal(
    v1WebFetchSchema.parse({ url: "https://example.com", model: "firecrawl/fetch", format: "text" })
      .format,
    "text"
  );
  assert.equal(
    v1WebFetchSchema.parse({ url: "https://example.com", provider: "exa" }).provider,
    "exa"
  );
});

test("9router response wraps content without inventing billed usage", () => {
  const result = toNineRouterWebFetchResponse(
    {
      provider: "exa-search",
      url: "https://example.com",
      content: "abc",
      links: ["https://example.com/next"],
      metadata: { title: "Example", description: null },
      screenshot_url: null,
    },
    "markdown",
    14,
    12
  );
  assert.equal(result.provider, "exa");
  assert.deepEqual(result.content, { format: "markdown", text: "abc", length: 3 });
  assert.deepEqual(result.usage, { fetch_cost_usd: null });
  assert.deepEqual(result.metrics, { response_time_ms: 14, upstream_latency_ms: 12 });
});
