import assert from "node:assert/strict";
import test from "node:test";

import { resolveNineRouterSearchModel } from "../../src/app/api/v1/search/nineRouterCompat.ts";
import { v1SearchSchema } from "../../src/shared/validation/schemas/apiV1.ts";

test("9router search model chooses its provider instead of auto-select", () => {
  assert.equal(
    v1SearchSchema.parse({ query: "example", model: "tavily/search" }).model,
    "tavily/search"
  );
  assert.deepEqual(resolveNineRouterSearchModel("tavily/search", undefined), {
    ok: true,
    provider: "tavily-search",
  });
  assert.deepEqual(resolveNineRouterSearchModel("exa", "exa-search"), {
    ok: true,
    provider: "exa-search",
  });
  assert.deepEqual(resolveNineRouterSearchModel("xquik/search", undefined), {
    ok: true,
    provider: "xquik-search",
  });
  assert.deepEqual(resolveNineRouterSearchModel("tavily", "exa-search"), {
    ok: false,
    reason: "Unknown or conflicting search model",
  });
  assert.deepEqual(resolveNineRouterSearchModel("missing/search", undefined), {
    ok: false,
    reason: "Unknown or conflicting search model",
  });
});

test("unimplemented search-combo fails explicitly instead of silently auto-selecting", () => {
  assert.deepEqual(resolveNineRouterSearchModel("search-combo", undefined), {
    ok: false,
    reason: "Configured search-combo routing is not available",
  });
});
